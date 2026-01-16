/**
 * DuckDB Bindings for Cloudflare Workers
 *
 * This binding class is designed to work with Cloudflare Workers' async fetch API
 * and integrates with the Workers runtime for async/await support.
 *
 * Key differences from browser bindings:
 * - Uses async fetch() instead of synchronous XMLHttpRequest
 * - No pthread worker support (Workers don't support Web Workers within Workers)
 * - Simplified WASM instantiation using WebAssembly.instantiate
 * - Integration with WORKERS_RUNTIME for file operations
 */

import { DuckDBModule } from './duckdb_module';
import { DuckDBBindingsBase } from './bindings_base';
import { DuckDBRuntime } from './runtime';
import { LogLevel, LogTopic, LogOrigin, LogEvent } from '../log';
import { Logger } from '../log';
import { InstantiationProgress } from '.';

/** Configuration for instantiating DuckDB in Cloudflare Workers */
export interface CloudflareInstantiateConfig {
    /** The compiled WebAssembly module (from wasm binding) */
    wasmModule?: WebAssembly.Module;
    /** The URL to fetch the WASM module from (alternative to wasmModule) */
    wasmURL?: string;
    /** The WASM binary as ArrayBuffer (alternative to wasmModule/wasmURL) */
    wasmBinary?: ArrayBuffer;
}

/** DuckDB bindings for Cloudflare Workers */
export abstract class DuckDBCloudflareBindings extends DuckDBBindingsBase {
    /** The WebAssembly module (pre-compiled or to be compiled) */
    protected wasmModule: WebAssembly.Module | null = null;
    /** The URL to fetch the WASM module from */
    protected wasmURL: string | null = null;
    /** The WASM binary */
    protected wasmBinary: ArrayBuffer | null = null;

    /** Constructor */
    public constructor(
        logger: Logger,
        runtime: DuckDBRuntime,
        config: CloudflareInstantiateConfig = {},
    ) {
        super(logger, runtime);
        this.wasmModule = config.wasmModule || null;
        this.wasmURL = config.wasmURL || null;
        this.wasmBinary = config.wasmBinary || null;
    }

    /**
     * Set the WebAssembly module directly
     * This is the recommended approach for Cloudflare Workers using wasm bindings
     */
    public setWasmModule(module: WebAssembly.Module): void {
        this.wasmModule = module;
    }

    /**
     * Set the WASM URL for fetching
     * This can be used if the WASM is served from a URL
     */
    public setWasmURL(url: string): void {
        this.wasmURL = url;
    }

    /**
     * Set the WASM binary directly
     */
    public setWasmBinary(binary: ArrayBuffer): void {
        this.wasmBinary = binary;
    }

    /** Locate a file - simplified for Workers (no pthread worker) */
    protected locateFile(path: string, prefix: string): string {
        if (path.endsWith('.wasm')) {
            if (this.wasmURL) {
                return this.wasmURL;
            }
            throw new Error('WASM URL not set and module not pre-compiled');
        }
        throw new Error(`WASM instantiation requested unexpected file: prefix=${prefix} path=${path}`);
    }

    /**
     * Instantiate the WASM module for Cloudflare Workers
     *
     * In Workers, we have three options:
     * 1. Pre-compiled WebAssembly.Module (recommended for wasm bindings)
     * 2. Fetch from URL and compile
     * 3. Compile from ArrayBuffer
     */
    protected instantiateWasm(
        // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
        imports: any,
        success: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
    ): Emscripten.WebAssemblyExports {
        globalThis.DUCKDB_RUNTIME = this._runtime;
        const handlers = this.onInstantiationProgress;

        const instantiate = async () => {
            let module: WebAssembly.Module;

            if (this.wasmModule) {
                // Option 1: Use pre-compiled module (fastest, recommended)
                module = this.wasmModule;
                const instance = await WebAssembly.instantiate(module, imports);
                success(instance, module);
            } else if (this.wasmBinary) {
                // Option 2: Compile from ArrayBuffer
                const start = new Date();
                const progress: InstantiationProgress = {
                    startedAt: start,
                    updatedAt: start,
                    bytesTotal: this.wasmBinary.byteLength,
                    bytesLoaded: this.wasmBinary.byteLength,
                };
                for (const p of handlers) {
                    p(progress);
                }

                const result = await WebAssembly.instantiate(this.wasmBinary, imports);
                success(result.instance, result.module);
            } else if (this.wasmURL) {
                // Option 3: Fetch and compile
                try {
                    const start = new Date();
                    const progress: InstantiationProgress = {
                        startedAt: start,
                        updatedAt: start,
                        bytesTotal: 0,
                        bytesLoaded: 0,
                    };

                    const response = await fetch(this.wasmURL);
                    const contentLengthHdr = response.headers.get('content-length');
                    progress.bytesTotal = contentLengthHdr ? parseInt(contentLengthHdr, 10) || 0 : 0;

                    // Try streaming instantiation first (if supported)
                    if (typeof WebAssembly.instantiateStreaming === 'function') {
                        try {
                            const result = await WebAssembly.instantiateStreaming(
                                fetch(this.wasmURL),
                                imports,
                            );
                            success(result.instance, result.module);
                            return;
                        } catch (streamError) {
                            // Fall back to ArrayBuffer approach
                            this.logger.log({
                                timestamp: new Date(),
                                level: LogLevel.WARNING,
                                origin: LogOrigin.BINDINGS,
                                topic: LogTopic.INSTANTIATE,
                                event: LogEvent.RUN,
                                value: 'Streaming instantiation failed, falling back to ArrayBuffer: ' + streamError,
                            });
                        }
                    }

                    // Fallback: fetch as ArrayBuffer
                    const buffer = await response.arrayBuffer();
                    progress.bytesLoaded = buffer.byteLength;
                    progress.bytesTotal = buffer.byteLength;
                    for (const p of handlers) {
                        p(progress);
                    }

                    const result = await WebAssembly.instantiate(buffer, imports);
                    success(result.instance, result.module);
                } catch (error) {
                    this.logger.log({
                        timestamp: new Date(),
                        level: LogLevel.ERROR,
                        origin: LogOrigin.BINDINGS,
                        topic: LogTopic.INSTANTIATE,
                        event: LogEvent.ERROR,
                        value: 'Failed to load WASM: ' + error,
                    });
                    throw error;
                }
            } else {
                throw new Error(
                    'No WASM module, binary, or URL provided. ' +
                    'Use setWasmModule(), setWasmBinary(), or setWasmURL() before instantiation.',
                );
            }
        };

        instantiate().catch(error => {
            this.logger.log({
                timestamp: new Date(),
                level: LogLevel.ERROR,
                origin: LogOrigin.BINDINGS,
                topic: LogTopic.INSTANTIATE,
                event: LogEvent.ERROR,
                value: 'WASM instantiation failed: ' + error,
            });
            throw error;
        });

        return [];
    }

    /// Instantiation must be done by the specific variants
    protected abstract instantiateImpl(moduleOverrides: Partial<DuckDBModule>): Promise<DuckDBModule>;
}

export default DuckDBCloudflareBindings;
