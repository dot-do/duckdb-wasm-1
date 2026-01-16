/**
 * DuckDB-WASM Runtime for Cloudflare Workers
 *
 * This runtime is designed to work with Cloudflare Workers' async fetch API
 * and integrates with Asyncify for async/await support in WASM.
 *
 * Key differences from browser runtime:
 * - Uses async fetch() instead of synchronous XMLHttpRequest
 * - All I/O operations return Promises that Asyncify will handle
 * - No OPFS or FileReader support (not available in Workers)
 * - HTTP Range requests for partial file reads
 * - S3 support via signed requests
 */

import { StatusCode } from '../status';
import { getHTTPUrl, getS3Params, createS3Headers, S3PayloadParams } from '../utils';
import { sha256 } from 'js-sha256';

import {
    callSRet,
    dropResponseBuffers,
    DuckDBDataProtocol,
    DuckDBFileInfo,
    DuckDBGlobalFileInfo,
    DuckDBRuntime,
    failWith,
    FileFlags,
    readString,
} from './runtime';
import { DuckDBModule } from './duckdb_module';
import * as udf from './udf_runtime';

/**
 * In-memory file buffer for buffered files
 */
interface BufferedFile {
    data: Uint8Array;
    lastModified: number;
}

/**
 * HTTP file metadata cached after opening
 */
interface HTTPFileHandle {
    url: string;
    size: number;
    lastModified: number;
    supportsRangeRequests: boolean;
    cachedData?: Uint8Array; // Full file data if range requests not supported
}

/**
 * Create S3 headers for fetch() requests
 */
function createS3HeadersForFetch(
    config: any,
    url: string,
    method: string,
    contentType: string | null = null,
    payload: Uint8Array | null = null,
): Headers {
    const headers = new Headers();

    if (config?.accessKeyId || config?.sessionToken) {
        const params = getS3Params(config, url, method);
        const payloadParams = {
            contentType: contentType,
            contentHash: payload ? sha256.hex(payload!) : null,
        } as S3PayloadParams;
        const s3Headers = createS3Headers(params, payloadParams);

        s3Headers.forEach((value: string, header: string) => {
            headers.set(header, value);
        });

        if (contentType) {
            headers.set('content-type', contentType);
        }
    }

    return headers;
}

export const WORKERS_RUNTIME: DuckDBRuntime & {
    _files: Map<string, BufferedFile | HTTPFileHandle>;
    _fileInfoCache: Map<number, DuckDBFileInfo>;
    _globalFileInfo: DuckDBGlobalFileInfo | null;

    getFileInfo(mod: DuckDBModule, fileId: number): DuckDBFileInfo | null;
    getGlobalFileInfo(mod: DuckDBModule): DuckDBGlobalFileInfo | null;

    // Async versions for Asyncify integration
    openFileAsync(mod: DuckDBModule, fileId: number, flags: FileFlags): Promise<number>;
    readFileAsync(mod: DuckDBModule, fileId: number, buf: number, bytes: number, location: number): Promise<number>;
    writeFileAsync(mod: DuckDBModule, fileId: number, buf: number, bytes: number, location: number): Promise<number>;
    globAsync(mod: DuckDBModule, pathPtr: number, pathLen: number): Promise<void>;
    checkFileAsync(mod: DuckDBModule, pathPtr: number, pathLen: number): Promise<boolean>;
} = {
    _files: new Map<string, BufferedFile | HTTPFileHandle>(),
    _fileInfoCache: new Map<number, DuckDBFileInfo>(),
    _udfFunctions: new Map(),
    _globalFileInfo: null,

    /**
     * Get file info from the WASM module
     */
    getFileInfo(mod: DuckDBModule, fileId: number): DuckDBFileInfo | null {
        try {
            const cached = WORKERS_RUNTIME._fileInfoCache.get(fileId);
            const [s, d, n] = callSRet(
                mod,
                'duckdb_web_fs_get_file_info_by_id',
                ['number', 'number'],
                [fileId, cached?.cacheEpoch || 0],
            );
            if (s !== StatusCode.SUCCESS) {
                return null;
            } else if (n === 0) {
                // Epoch is up to date
                return cached!;
            }
            const infoStr = readString(mod, d, n);
            dropResponseBuffers(mod);
            try {
                const info = JSON.parse(infoStr);
                if (info == null) {
                    return null;
                }
                const file = { ...info } as DuckDBFileInfo;
                WORKERS_RUNTIME._fileInfoCache.set(fileId, file);
                return file;
            } catch (error) {
                console.warn(error);
                return null;
            }
        } catch (e: any) {
            console.log(e);
            return null;
        }
    },

    /**
     * Get global file info from the WASM module
     */
    getGlobalFileInfo(mod: DuckDBModule): DuckDBGlobalFileInfo | null {
        try {
            const [s, d, n] = callSRet(
                mod,
                'duckdb_web_get_global_file_info',
                ['number'],
                [WORKERS_RUNTIME._globalFileInfo?.cacheEpoch || 0],
            );
            if (s !== StatusCode.SUCCESS) {
                return null;
            } else if (n === 0) {
                // Epoch is up to date
                return WORKERS_RUNTIME._globalFileInfo!;
            }
            const infoStr = readString(mod, d, n);
            dropResponseBuffers(mod);
            const info = JSON.parse(infoStr);
            if (info == null) {
                return null;
            }
            WORKERS_RUNTIME._globalFileInfo = { ...info } as DuckDBGlobalFileInfo;
            return WORKERS_RUNTIME._globalFileInfo;
        } catch (e: any) {
            console.log(e);
            return null;
        }
    },

    /**
     * Test platform features
     */
    testPlatformFeature: (_mod: DuckDBModule, feature: number): boolean => {
        switch (feature) {
            case 1:
                return typeof BigInt64Array !== 'undefined';
            default:
                console.warn(`test for unknown feature: ${feature}`);
                return false;
        }
    },

    /**
     * Get default data protocol - HTTP for Workers
     */
    getDefaultDataProtocol(_mod: DuckDBModule): number {
        return DuckDBDataProtocol.HTTP;
    },

    /**
     * Async file open - uses fetch() for HTTP/S3 files
     * This is the main entry point called by Asyncify
     */
    async openFileAsync(mod: DuckDBModule, fileId: number, flags: FileFlags): Promise<number> {
        try {
            WORKERS_RUNTIME._fileInfoCache.delete(fileId);
            const file = WORKERS_RUNTIME.getFileInfo(mod, fileId);

            switch (file?.dataProtocol) {
                case DuckDBDataProtocol.HTTP:
                case DuckDBDataProtocol.S3: {
                    if (flags & FileFlags.FILE_FLAGS_READ && flags & FileFlags.FILE_FLAGS_WRITE) {
                        throw new Error(
                            `Opening file ${file.fileName} failed: cannot open file with both read and write flags set`,
                        );
                    } else if (flags & FileFlags.FILE_FLAGS_APPEND) {
                        throw new Error(
                            `Opening file ${file.fileName} failed: appending to HTTP/S3 files is not supported`,
                        );
                    } else if (flags & FileFlags.FILE_FLAGS_WRITE) {
                        // For write mode, check if we can write
                        const url =
                            file.dataProtocol === DuckDBDataProtocol.S3
                                ? getHTTPUrl(file.s3Config, file.dataUrl!)
                                : file.dataUrl!;
                        const headers =
                            file.dataProtocol === DuckDBDataProtocol.S3
                                ? createS3HeadersForFetch(file.s3Config, file.dataUrl!, 'HEAD')
                                : new Headers();

                        const response = await fetch(url, { method: 'HEAD', headers });

                        // Expect 200 for existing files or 404 for non-existent files
                        if (response.status !== 200 && response.status !== 404) {
                            throw new Error(
                                `Opening file ${file.fileName} failed: Unexpected return status from server (${response.status})`,
                            );
                        } else if (
                            response.status === 404 &&
                            !(flags & FileFlags.FILE_FLAGS_FILE_CREATE || flags & FileFlags.FILE_FLAGS_FILE_CREATE_NEW)
                        ) {
                            throw new Error(
                                `Opening file ${file.fileName} failed: Cannot write to non-existent file without FILE_FLAGS_FILE_CREATE or FILE_FLAGS_FILE_CREATE_NEW flag.`,
                            );
                        }

                        // Return an empty buffer for writes
                        const data = mod._malloc(1);
                        const src = new Uint8Array();
                        mod.HEAPU8.set(src, data);
                        const result = mod._malloc(3 * 8);
                        mod.HEAPF64[(result >> 3) + 0] = 1;
                        mod.HEAPF64[(result >> 3) + 1] = data;
                        mod.HEAPF64[(result >> 3) + 2] = new Date().getTime() / 1000;
                        return result;
                    } else if ((flags & FileFlags.FILE_FLAGS_READ) === 0) {
                        throw new Error(`Opening file ${file.fileName} failed: unsupported file flags: ${flags}`);
                    }

                    // Read mode - check if range requests are supported
                    const url =
                        file.dataProtocol === DuckDBDataProtocol.S3
                            ? getHTTPUrl(file.s3Config, file.dataUrl!)
                            : file.dataUrl!;
                    const headers =
                        file.dataProtocol === DuckDBDataProtocol.S3
                            ? createS3HeadersForFetch(file.s3Config, file.dataUrl!, 'HEAD')
                            : new Headers();

                    // First, try a HEAD request to check for range support
                    let contentLength: number | null = null;
                    let lastModified = 0;
                    let supportsRangeRequests = false;

                    if (!file.forceFullHttpReads && (file.reliableHeadRequests || !file.allowFullHttpReads)) {
                        try {
                            headers.set('Range', 'bytes=0-');
                            const headResponse = await fetch(url, { method: 'HEAD', headers });

                            if (headResponse.status === 206) {
                                const contentLengthHeader = headResponse.headers.get('Content-Length');
                                if (contentLengthHeader) {
                                    contentLength = parseInt(contentLengthHeader, 10);
                                    supportsRangeRequests = true;
                                }
                                const lastModifiedHeader = headResponse.headers.get('Last-Modified');
                                if (lastModifiedHeader) {
                                    lastModified = new Date(lastModifiedHeader).getTime() / 1000;
                                }
                            }
                        } catch (e: any) {
                            console.warn(`HEAD request with range header failed: ${e}`);
                        }
                    }

                    // If HEAD didn't work, try a range GET for first byte
                    if (contentLength === null && file.allowFullHttpReads) {
                        if (!file.forceFullHttpReads) {
                            const getHeaders =
                                file.dataProtocol === DuckDBDataProtocol.S3
                                    ? createS3HeadersForFetch(file.s3Config, file.dataUrl!, 'GET')
                                    : new Headers();
                            getHeaders.set('Range', 'bytes=0-0');

                            const rangeResponse = await fetch(url, { method: 'GET', headers: getHeaders });

                            if (rangeResponse.status === 206) {
                                // Check Content-Range header for total size
                                const contentRange = rangeResponse.headers.get('Content-Range');
                                if (contentRange) {
                                    const match = contentRange.match(/\/(\d+)$/);
                                    if (match) {
                                        contentLength = parseInt(match[1], 10);
                                        supportsRangeRequests = true;
                                    }
                                }
                                const lastModifiedHeader = rangeResponse.headers.get('Last-Modified');
                                if (lastModifiedHeader) {
                                    lastModified = new Date(lastModifiedHeader).getTime() / 1000;
                                }
                            } else if (rangeResponse.status === 200) {
                                // Server doesn't support range requests, fall back to full read
                                console.warn(`fall back to full HTTP read for: ${file.dataUrl}`);
                                const fullData = new Uint8Array(await rangeResponse.arrayBuffer());

                                // Cache the full file
                                const httpHandle: HTTPFileHandle = {
                                    url,
                                    size: fullData.byteLength,
                                    lastModified,
                                    supportsRangeRequests: false,
                                    cachedData: fullData,
                                };
                                WORKERS_RUNTIME._files.set(file.fileName, httpHandle);

                                const data = mod._malloc(fullData.byteLength);
                                mod.HEAPU8.set(fullData, data);
                                const result = mod._malloc(3 * 8);
                                mod.HEAPF64[(result >> 3) + 0] = fullData.byteLength;
                                mod.HEAPF64[(result >> 3) + 1] = data;
                                mod.HEAPF64[(result >> 3) + 2] = lastModified;
                                return result;
                            }
                        }

                        // If still no size, do a full GET
                        if (contentLength === null) {
                            console.warn(`falling back to full HTTP read for: ${file.dataUrl}`);
                            const getHeaders =
                                file.dataProtocol === DuckDBDataProtocol.S3
                                    ? createS3HeadersForFetch(file.s3Config, file.dataUrl!, 'GET')
                                    : new Headers();

                            const fullResponse = await fetch(url, { method: 'GET', headers: getHeaders });

                            if (fullResponse.status === 200) {
                                const fullData = new Uint8Array(await fullResponse.arrayBuffer());
                                const lastModifiedHeader = fullResponse.headers.get('Last-Modified');
                                if (lastModifiedHeader) {
                                    lastModified = new Date(lastModifiedHeader).getTime() / 1000;
                                }

                                // Cache the full file
                                const httpHandle: HTTPFileHandle = {
                                    url,
                                    size: fullData.byteLength,
                                    lastModified,
                                    supportsRangeRequests: false,
                                    cachedData: fullData,
                                };
                                WORKERS_RUNTIME._files.set(file.fileName, httpHandle);

                                const data = mod._malloc(fullData.byteLength);
                                mod.HEAPU8.set(fullData, data);
                                const result = mod._malloc(3 * 8);
                                mod.HEAPF64[(result >> 3) + 0] = fullData.byteLength;
                                mod.HEAPF64[(result >> 3) + 1] = data;
                                mod.HEAPF64[(result >> 3) + 2] = lastModified;
                                return result;
                            }
                        }
                    }

                    // Range requests supported, store handle
                    if (contentLength !== null && supportsRangeRequests) {
                        const httpHandle: HTTPFileHandle = {
                            url,
                            size: contentLength,
                            lastModified,
                            supportsRangeRequests: true,
                        };
                        WORKERS_RUNTIME._files.set(file.fileName, httpHandle);

                        const result = mod._malloc(3 * 8);
                        mod.HEAPF64[(result >> 3) + 0] = contentLength;
                        mod.HEAPF64[(result >> 3) + 1] = 0;
                        mod.HEAPF64[(result >> 3) + 2] = lastModified;
                        return result;
                    }

                    return 0;
                }

                case DuckDBDataProtocol.BUFFER: {
                    // In-memory buffer
                    const handle = WORKERS_RUNTIME._files?.get(file.fileName) as BufferedFile | undefined;
                    if (handle) {
                        const result = mod._malloc(3 * 8);
                        mod.HEAPF64[(result >> 3) + 0] = handle.data.byteLength;
                        mod.HEAPF64[(result >> 3) + 1] = 0;
                        mod.HEAPF64[(result >> 3) + 2] = handle.lastModified;
                        return result;
                    }

                    // Depending on file flags, return nullptr
                    if (flags & FileFlags.FILE_FLAGS_NULL_IF_NOT_EXISTS) {
                        return 0;
                    }

                    // Create empty buffer
                    console.warn(`Buffering missing file: ${file.fileName}`);
                    const emptyBuffer: BufferedFile = {
                        data: new Uint8Array(0),
                        lastModified: Date.now() / 1000,
                    };
                    WORKERS_RUNTIME._files.set(file.fileName, emptyBuffer);

                    const result = mod._malloc(3 * 8);
                    const buffer = mod._malloc(1);
                    mod.HEAPF64[(result >> 3) + 0] = 1;
                    mod.HEAPF64[(result >> 3) + 1] = buffer;
                    mod.HEAPF64[(result >> 3) + 2] = 0;
                    return result;
                }

                // Unsupported protocols in Workers
                case DuckDBDataProtocol.BROWSER_FILEREADER:
                case DuckDBDataProtocol.BROWSER_FSACCESS:
                case DuckDBDataProtocol.NODE_FS:
                    throw new Error(
                        `Data protocol ${file.dataProtocol} is not supported in Cloudflare Workers environment`,
                    );
            }
        } catch (e: any) {
            console.error(e.toString());
            failWith(mod, e.toString());
        }
        return 0;
    },

    /**
     * Sync openFile - wrapper that will be called by Asyncify
     */
    openFile(mod: DuckDBModule, fileId: number, flags: FileFlags): number {
        // This will be wrapped by Asyncify to handle the Promise
        // @ts-ignore - Asyncify will handle Promise return
        return WORKERS_RUNTIME.openFileAsync(mod, fileId, flags);
    },

    /**
     * Async file read using fetch() with Range header
     */
    async readFileAsync(
        mod: DuckDBModule,
        fileId: number,
        buf: number,
        bytes: number,
        location: number,
    ): Promise<number> {
        if (bytes === 0) {
            return 0;
        }

        try {
            const file = WORKERS_RUNTIME.getFileInfo(mod, fileId);

            switch (file?.dataProtocol) {
                case DuckDBDataProtocol.HTTP:
                case DuckDBDataProtocol.S3: {
                    if (!file.dataUrl) {
                        throw new Error(`Missing data URL for file ${fileId}`);
                    }

                    const handle = WORKERS_RUNTIME._files.get(file.fileName) as HTTPFileHandle | undefined;

                    // If we have cached data (full file fallback), read from cache
                    if (handle?.cachedData) {
                        const src = handle.cachedData.subarray(
                            location,
                            Math.min(location + bytes, handle.cachedData.byteLength),
                        );
                        mod.HEAPU8.set(src, buf);
                        return src.byteLength;
                    }

                    // Perform range request
                    const url =
                        file.dataProtocol === DuckDBDataProtocol.S3
                            ? getHTTPUrl(file.s3Config, file.dataUrl!)
                            : file.dataUrl!;
                    const headers =
                        file.dataProtocol === DuckDBDataProtocol.S3
                            ? createS3HeadersForFetch(file.s3Config, file.dataUrl!, 'GET')
                            : new Headers();

                    headers.set('Range', `bytes=${location}-${location + bytes - 1}`);

                    const response = await fetch(url, { method: 'GET', headers });

                    if (response.status === 206 || (response.status === 200 && location === 0)) {
                        const data = new Uint8Array(await response.arrayBuffer());
                        const src = data.subarray(0, Math.min(data.byteLength, bytes));
                        mod.HEAPU8.set(src, buf);
                        return src.byteLength;
                    } else if (response.status === 200) {
                        // Server returned full file instead of range
                        console.warn(
                            `Range request for ${file.dataUrl} did not return a partial response: ${response.status}`,
                        );
                        const fullData = new Uint8Array(await response.arrayBuffer());
                        const src = fullData.subarray(
                            location,
                            Math.min(location + bytes, fullData.byteLength),
                        );
                        mod.HEAPU8.set(src, buf);
                        return src.byteLength;
                    } else {
                        throw new Error(
                            `Range request for ${file.dataUrl} returned non-success status: ${response.status}`,
                        );
                    }
                }

                case DuckDBDataProtocol.BUFFER: {
                    const handle = WORKERS_RUNTIME._files.get(file.fileName) as BufferedFile | undefined;
                    if (!handle) {
                        throw new Error(`No buffer registered with name: ${file.fileName}`);
                    }
                    const src = handle.data.subarray(location, Math.min(location + bytes, handle.data.byteLength));
                    mod.HEAPU8.set(src, buf);
                    return src.byteLength;
                }

                case DuckDBDataProtocol.BROWSER_FILEREADER:
                case DuckDBDataProtocol.BROWSER_FSACCESS:
                case DuckDBDataProtocol.NODE_FS:
                    throw new Error(
                        `Data protocol ${file.dataProtocol} is not supported in Cloudflare Workers environment`,
                    );
            }
            return 0;
        } catch (e: any) {
            console.log(e);
            failWith(mod, e.toString());
            return 0;
        }
    },

    /**
     * Sync readFile - wrapper that will be called by Asyncify
     */
    readFile(mod: DuckDBModule, fileId: number, buf: number, bytes: number, location: number): number {
        // This will be wrapped by Asyncify to handle the Promise
        // @ts-ignore - Asyncify will handle Promise return
        return WORKERS_RUNTIME.readFileAsync(mod, fileId, buf, bytes, location);
    },

    /**
     * Async file write using fetch() PUT
     */
    async writeFileAsync(
        mod: DuckDBModule,
        fileId: number,
        buf: number,
        bytes: number,
        location: number,
    ): Promise<number> {
        const file = WORKERS_RUNTIME.getFileInfo(mod, fileId);

        switch (file?.dataProtocol) {
            case DuckDBDataProtocol.HTTP:
                failWith(mod, 'Cannot write to HTTP file');
                return 0;

            case DuckDBDataProtocol.S3: {
                const buffer = mod.HEAPU8.subarray(buf, buf + bytes);
                const url = getHTTPUrl(file?.s3Config, file.dataUrl!);
                const headers = createS3HeadersForFetch(file?.s3Config, file.dataUrl!, 'PUT', '', buffer);

                const response = await fetch(url, {
                    method: 'PUT',
                    headers,
                    body: buffer,
                });

                if (response.status !== 200) {
                    failWith(mod, 'Failed writing file: HTTP ' + response.status);
                    return 0;
                }
                return bytes;
            }

            case DuckDBDataProtocol.BUFFER: {
                const handle = WORKERS_RUNTIME._files.get(file.fileName) as BufferedFile | undefined;
                if (!handle) {
                    // Create new buffer
                    const newData = new Uint8Array(location + bytes);
                    newData.set(mod.HEAPU8.subarray(buf, buf + bytes), location);
                    WORKERS_RUNTIME._files.set(file.fileName, {
                        data: newData,
                        lastModified: Date.now() / 1000,
                    });
                    return bytes;
                }

                // Expand buffer if needed
                if (location + bytes > handle.data.byteLength) {
                    const newData = new Uint8Array(location + bytes);
                    newData.set(handle.data);
                    handle.data = newData;
                }

                handle.data.set(mod.HEAPU8.subarray(buf, buf + bytes), location);
                handle.lastModified = Date.now() / 1000;
                return bytes;
            }

            case DuckDBDataProtocol.BROWSER_FILEREADER:
            case DuckDBDataProtocol.BROWSER_FSACCESS:
            case DuckDBDataProtocol.NODE_FS:
                failWith(
                    mod,
                    `Data protocol ${file?.dataProtocol} is not supported in Cloudflare Workers environment`,
                );
                return 0;
        }
        return 0;
    },

    /**
     * Sync writeFile - wrapper that will be called by Asyncify
     */
    writeFile(mod: DuckDBModule, fileId: number, buf: number, bytes: number, location: number): number {
        // This will be wrapped by Asyncify to handle the Promise
        // @ts-ignore - Asyncify will handle Promise return
        return WORKERS_RUNTIME.writeFileAsync(mod, fileId, buf, bytes, location);
    },

    /**
     * Async glob for HTTP/S3 URLs
     */
    async globAsync(mod: DuckDBModule, pathPtr: number, pathLen: number): Promise<void> {
        try {
            const path = readString(mod, pathPtr, pathLen);

            if (path.startsWith('http') || path.startsWith('s3://')) {
                // For HTTP/S3, we check if the file exists
                let url = path;
                let headers = new Headers();

                if (path.startsWith('s3://')) {
                    const globalInfo = WORKERS_RUNTIME.getGlobalFileInfo(mod);
                    url = getHTTPUrl(globalInfo?.s3Config, path);
                    headers = createS3HeadersForFetch(globalInfo?.s3Config, path, 'HEAD');
                }

                const response = await fetch(url, { method: 'HEAD', headers });

                if (response.status === 200 || response.status === 206) {
                    mod.ccall('duckdb_web_fs_glob_add_path', null, ['string'], [path]);
                } else if (WORKERS_RUNTIME.getGlobalFileInfo(mod)?.allowFullHttpReads) {
                    // Try a range GET as fallback
                    const getHeaders = path.startsWith('s3://')
                        ? createS3HeadersForFetch(WORKERS_RUNTIME.getGlobalFileInfo(mod)?.s3Config, path, 'GET')
                        : new Headers();
                    getHeaders.set('Range', 'bytes=0-0');

                    const rangeResponse = await fetch(url, { method: 'GET', headers: getHeaders });

                    if (rangeResponse.status === 200 || rangeResponse.status === 206) {
                        mod.ccall('duckdb_web_fs_glob_add_path', null, ['string'], [path]);
                    } else {
                        console.log(`HEAD and GET requests failed: ${path}`);
                    }
                } else {
                    console.log(`HEAD request failed: ${path}, with full http reads are disabled`);
                }
            } else {
                // For local paths, check our in-memory files
                for (const [filePath] of WORKERS_RUNTIME._files.entries()) {
                    if (filePath.startsWith(path)) {
                        mod.ccall('duckdb_web_fs_glob_add_path', null, ['string'], [filePath]);
                    }
                }
            }
        } catch (e: any) {
            console.log(e);
            failWith(mod, e.toString());
        }
    },

    /**
     * Sync glob - wrapper that will be called by Asyncify
     */
    glob(mod: DuckDBModule, pathPtr: number, pathLen: number): void {
        // This will be wrapped by Asyncify to handle the Promise
        // @ts-ignore - Asyncify will handle Promise return
        WORKERS_RUNTIME.globAsync(mod, pathPtr, pathLen);
    },

    /**
     * Async file check
     */
    async checkFileAsync(mod: DuckDBModule, pathPtr: number, pathLen: number): Promise<boolean> {
        try {
            const path = readString(mod, pathPtr, pathLen);

            if (path.startsWith('http') || path.startsWith('s3://')) {
                let url = path;
                let headers = new Headers();

                if (path.startsWith('s3://')) {
                    const globalInfo = WORKERS_RUNTIME.getGlobalFileInfo(mod);
                    url = getHTTPUrl(globalInfo?.s3Config, path);
                    headers = createS3HeadersForFetch(globalInfo?.s3Config, path, 'HEAD');
                }

                const response = await fetch(url, { method: 'HEAD', headers });
                return response.status === 200 || response.status === 206;
            } else {
                return WORKERS_RUNTIME._files.has(path);
            }
        } catch (e: any) {
            console.log(e);
            return false;
        }
    },

    /**
     * Sync checkFile - wrapper that will be called by Asyncify
     */
    checkFile(mod: DuckDBModule, pathPtr: number, pathLen: number): boolean {
        // This will be wrapped by Asyncify to handle the Promise
        // @ts-ignore - Asyncify will handle Promise return
        return WORKERS_RUNTIME.checkFileAsync(mod, pathPtr, pathLen);
    },

    /**
     * Sync file - no-op for HTTP files
     */
    syncFile(_mod: DuckDBModule, _fileId: number): void {},

    /**
     * Close file
     */
    closeFile(mod: DuckDBModule, fileId: number): void {
        const file = WORKERS_RUNTIME.getFileInfo(mod, fileId);
        WORKERS_RUNTIME._fileInfoCache.delete(fileId);

        // For HTTP files with cached data, we may want to free memory
        // But keep the handle for potential re-open
        if (file?.dataProtocol === DuckDBDataProtocol.HTTP || file?.dataProtocol === DuckDBDataProtocol.S3) {
            const handle = WORKERS_RUNTIME._files.get(file.fileName) as HTTPFileHandle | undefined;
            if (handle?.cachedData) {
                // Optionally clear cached data to free memory
                // handle.cachedData = undefined;
            }
        }
    },

    /**
     * Drop file from registry
     */
    dropFile(mod: DuckDBModule, fileNamePtr: number, fileNameLen: number): void {
        const fileName = readString(mod, fileNamePtr, fileNameLen);
        WORKERS_RUNTIME._files.delete(fileName);
    },

    /**
     * Truncate file (only for buffers)
     */
    truncateFile(mod: DuckDBModule, fileId: number, newSize: number): void {
        const file = WORKERS_RUNTIME.getFileInfo(mod, fileId);

        switch (file?.dataProtocol) {
            case DuckDBDataProtocol.HTTP:
                failWith(mod, 'Cannot truncate a HTTP file');
                return;
            case DuckDBDataProtocol.S3:
                failWith(mod, 'Cannot truncate an S3 file');
                return;
            case DuckDBDataProtocol.BUFFER: {
                const handle = WORKERS_RUNTIME._files.get(file.fileName) as BufferedFile | undefined;
                if (handle) {
                    if (newSize < handle.data.byteLength) {
                        handle.data = handle.data.subarray(0, newSize);
                    } else if (newSize > handle.data.byteLength) {
                        const newData = new Uint8Array(newSize);
                        newData.set(handle.data);
                        handle.data = newData;
                    }
                    handle.lastModified = Date.now() / 1000;
                }
                return;
            }
            default:
                failWith(mod, 'truncateFile not implemented for this protocol');
                return;
        }
    },

    /**
     * Get last file modification time
     */
    getLastFileModificationTime(mod: DuckDBModule, fileId: number): number {
        const file = WORKERS_RUNTIME.getFileInfo(mod, fileId);

        switch (file?.dataProtocol) {
            case DuckDBDataProtocol.HTTP:
            case DuckDBDataProtocol.S3: {
                const handle = WORKERS_RUNTIME._files.get(file.fileName) as HTTPFileHandle | undefined;
                return handle?.lastModified || Date.now() / 1000;
            }
            case DuckDBDataProtocol.BUFFER: {
                const handle = WORKERS_RUNTIME._files.get(file.fileName) as BufferedFile | undefined;
                return handle?.lastModified || 0;
            }
        }
        return 0;
    },

    /**
     * Progress update - no-op in Workers (no postMessage to main thread)
     */
    progressUpdate(_done: number, _percentage: number, _repeat: number): void {
        // In Workers, we don't have a main thread to notify
        // Could potentially use Durable Objects or other mechanisms
    },

    /**
     * Directory operations - limited support in Workers
     */
    checkDirectory(_mod: DuckDBModule, _pathPtr: number, _pathLen: number): boolean {
        // No filesystem in Workers
        return false;
    },

    createDirectory(_mod: DuckDBModule, _pathPtr: number, _pathLen: number): void {
        // No filesystem in Workers - no-op
    },

    removeDirectory(_mod: DuckDBModule, _pathPtr: number, _pathLen: number): void {
        // No filesystem in Workers - no-op
    },

    listDirectoryEntries(_mod: DuckDBModule, _pathPtr: number, _pathLen: number): boolean {
        // No filesystem in Workers
        return false;
    },

    /**
     * Move file - only works for in-memory files
     */
    moveFile(mod: DuckDBModule, fromPtr: number, fromLen: number, toPtr: number, toLen: number): boolean {
        const from = readString(mod, fromPtr, fromLen);
        const to = readString(mod, toPtr, toLen);

        const handle = WORKERS_RUNTIME._files.get(from);
        if (handle !== undefined) {
            WORKERS_RUNTIME._files.delete(from);
            WORKERS_RUNTIME._files.set(to, handle);
        }

        for (const [key, value] of WORKERS_RUNTIME._fileInfoCache.entries()) {
            if (value.dataUrl === from) {
                WORKERS_RUNTIME._fileInfoCache.delete(key);
                break;
            }
        }

        return true;
    },

    /**
     * Remove file from registry
     */
    removeFile(_mod: DuckDBModule, pathPtr: number, pathLen: number): void {
        const path = readString(_mod, pathPtr, pathLen);
        WORKERS_RUNTIME._files.delete(path);
    },

    /**
     * Call scalar UDF
     */
    callScalarUDF(
        mod: DuckDBModule,
        response: number,
        funcId: number,
        descPtr: number,
        descSize: number,
        ptrsPtr: number,
        ptrsSize: number,
    ): void {
        udf.callScalarUDF(WORKERS_RUNTIME, mod, response, funcId, descPtr, descSize, ptrsPtr, ptrsSize);
    },
};

/**
 * Helper function to register an in-memory file buffer
 */
export function registerBuffer(name: string, data: Uint8Array): void {
    WORKERS_RUNTIME._files.set(name, {
        data,
        lastModified: Date.now() / 1000,
    } as BufferedFile);
}

/**
 * Helper function to get an in-memory file buffer
 */
export function getBuffer(name: string): Uint8Array | null {
    const file = WORKERS_RUNTIME._files.get(name) as BufferedFile | undefined;
    return file?.data || null;
}

/**
 * Helper function to clear all cached files
 */
export function clearFileCache(): void {
    WORKERS_RUNTIME._files.clear();
    WORKERS_RUNTIME._fileInfoCache.clear();
    WORKERS_RUNTIME._globalFileInfo = null;
}

export default WORKERS_RUNTIME;
