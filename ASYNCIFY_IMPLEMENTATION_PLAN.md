# DuckDB-WASM Asyncify Implementation Plan

## Executive Summary

This document provides a detailed, actionable implementation plan for adding Asyncify support to DuckDB-WASM, enabling asynchronous HTTP requests in Cloudflare Workers where synchronous `XMLHttpRequest` is not available.

**Goal**: Replace synchronous `XMLHttpRequest` calls with async `fetch()` using Emscripten's Asyncify feature, allowing DuckDB-WASM to run in Cloudflare Workers.

**Estimated Total Effort**: 32-48 hours

---

## Table of Contents

1. [Background](#1-background)
2. [Architecture Overview](#2-architecture-overview)
3. [Implementation Tasks](#3-implementation-tasks)
4. [Risk Assessment](#4-risk-assessment)
5. [Test Strategy](#5-test-strategy)
6. [Build & Deployment](#6-build--deployment)
7. [Timeline](#7-timeline)

---

## 1. Background

### Current Problem

DuckDB-WASM uses synchronous `XMLHttpRequest` for HTTP operations (GET, HEAD, POST, PUT, DELETE). This pattern is:

1. **Blocking**: Requires `xhr.open(method, url, false)` - the third parameter `false` makes it synchronous
2. **Incompatible with Workers**: Cloudflare Workers (and Web Workers generally) do not support synchronous XHR
3. **Located in two places**:
   - C++ layer: `/lib/src/http_wasm.cc` - uses `EM_ASM_PTR` with inline JavaScript
   - TypeScript layer: `/packages/duckdb-wasm/src/bindings/runtime_browser.ts` - direct XHR calls

### Solution: Asyncify

Emscripten's Asyncify allows C/C++ code to "pause" execution while JavaScript performs an async operation. When the async operation completes, C++ execution resumes exactly where it left off.

**Key Asyncify Components**:
- **Compiler flag**: `-sASYNCIFY` enables the transformation
- **Asyncify.handleAsync()**: Wraps async JavaScript functions for C++ consumption
- **Stack unwinding/rewinding**: Saves and restores the C++ call stack

---

## 2. Architecture Overview

### File Dependency Graph

```
lib/CMakeLists.txt
    |
    +-- (build flags) --> duckdb_wasm.wasm + duckdb_wasm.js
                              |
                              +-- lib/js-stubs.js (runtime bindings)
                                      |
                                      +-- globalThis.DUCKDB_RUNTIME
                                              |
                                              +-- runtime_browser.ts (sync XHR)
                                              +-- runtime_workers.ts (NEW: async fetch)

lib/src/http_wasm.cc
    |
    +-- EM_ASM_PTR blocks with sync XHR
    +-- HTTPWasmClient::Get/Head/Post/Put/Delete
```

### Proposed New Architecture

```
                    +-----------------------+
                    |   CMakeLists.txt      |
                    |   + ASYNCIFY flags    |
                    +-----------+-----------+
                                |
            +-------------------+-------------------+
            |                                       |
    +-------v-------+                       +-------v-------+
    | http_wasm.cc  |                       | js-stubs.js   |
    | (call to JS   |<--------------------->| (Asyncify     |
    |  import)      |                       |  wrappers)    |
    +---------------+                       +-------+-------+
                                                    |
                                            +-------v-------+
                                            | DUCKDB_RUNTIME|
                                            +-------+-------+
                                                    |
                    +---------------+---------------+
                    |                               |
            +-------v-------+               +-------v-------+
            | runtime_      |               | runtime_      |
            | browser.ts    |               | workers.ts    |
            | (sync XHR)    |               | (async fetch) |
            +---------------+               +---------------+
```

---

## 3. Implementation Tasks

### Task 1: CMake Configuration for Asyncify

**File**: `/Users/nathanclevenger/projects/pocs/packages/duckdb-wasm-fork/lib/CMakeLists.txt`

**Location**: Lines 284-301 (EMSCRIPTEN section)

**Current Code** (lines 288-300):
```cmake
set_target_properties(
  duckdb_wasm
  PROPERTIES
    LINK_FLAGS
    "${WASM_LINK_FLAGS} \
    -s ALLOW_BLOCKING_ON_MAIN_THREAD=1 \
    -s WARN_ON_UNDEFINED_SYMBOLS=0 \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s MAXIMUM_MEMORY=4GB \
    -s MODULARIZE=1 \
    -s EXPORT_NAME='DuckDB' \
    -s EXPORTED_RUNTIME_METHODS='[\"ccall\", \"stackSave\", \"stackAlloc\", \"stackRestore\", \"createDyncallWrapper\", \"getTempRet0\", \"setTempRet0\"]' \
    --js-library=${CMAKE_SOURCE_DIR}/js-stubs.js")
```

**Modified Code**:
```cmake
# Asyncify configuration option
option(WITH_ASYNCIFY "Build with Asyncify for async HTTP support" OFF)

# Asyncify function list - functions that can yield to async JS
set(ASYNCIFY_IMPORTS "[\
  'duckdb_web_http_fetch_async',\
  'duckdb_web_http_head_async',\
  'duckdb_web_http_post_async',\
  'duckdb_web_http_put_async',\
  'duckdb_web_http_delete_async'\
]")

# Build Asyncify flags
if(WITH_ASYNCIFY)
  set(ASYNCIFY_FLAGS "\
    -sASYNCIFY=1 \
    -sASYNCIFY_STACK_SIZE=65536 \
    -sASYNCIFY_IMPORTS=${ASYNCIFY_IMPORTS}")
else()
  set(ASYNCIFY_FLAGS "")
endif()

set_target_properties(
  duckdb_wasm
  PROPERTIES
    LINK_FLAGS
    "${WASM_LINK_FLAGS} \
    ${ASYNCIFY_FLAGS} \
    -s ALLOW_BLOCKING_ON_MAIN_THREAD=1 \
    -s WARN_ON_UNDEFINED_SYMBOLS=0 \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s MAXIMUM_MEMORY=4GB \
    -s MODULARIZE=1 \
    -s EXPORT_NAME='DuckDB' \
    -s EXPORTED_RUNTIME_METHODS='[\"ccall\", \"stackSave\", \"stackAlloc\", \"stackRestore\", \"createDyncallWrapper\", \"getTempRet0\", \"setTempRet0\", \"Asyncify\"]' \
    --js-library=${CMAKE_SOURCE_DIR}/js-stubs.js")
```

**Estimated Hours**: 2-3

**Dependencies**: None

---

### Task 2: Update js-stubs.js with Asyncify Wrappers

**File**: `/Users/nathanclevenger/projects/pocs/packages/duckdb-wasm-fork/lib/js-stubs.js`

**Current Code** (full file, 77 lines):
```javascript
addToLibrary({
    duckdb_web_test_platform_feature__sig: 'ii',
    duckdb_web_test_platform_feature: function (feature) {
        return globalThis.DUCKDB_RUNTIME.testPlatformFeature(Module, feature);
    },
    // ... existing stubs ...
});
```

**Add New Asyncify HTTP Stubs** (append before closing `});`):

```javascript
    // ==========================================================================
    // ASYNCIFY HTTP FUNCTIONS - These yield to async JavaScript
    // ==========================================================================

    // Signature: (url_ptr, url_len, headers_ptr, headers_count, response_ptr) -> status
    duckdb_web_http_fetch_async__sig: 'ipiipp',
    duckdb_web_http_fetch_async__async: true,
    duckdb_web_http_fetch_async: function(urlPtr, urlLen, headersPtr, headersCount, responsePtr) {
        return Asyncify.handleAsync(async () => {
            return await globalThis.DUCKDB_RUNTIME.httpFetchAsync(
                Module, urlPtr, urlLen, headersPtr, headersCount, responsePtr
            );
        });
    },

    duckdb_web_http_head_async__sig: 'ipiipp',
    duckdb_web_http_head_async__async: true,
    duckdb_web_http_head_async: function(urlPtr, urlLen, headersPtr, headersCount, responsePtr) {
        return Asyncify.handleAsync(async () => {
            return await globalThis.DUCKDB_RUNTIME.httpHeadAsync(
                Module, urlPtr, urlLen, headersPtr, headersCount, responsePtr
            );
        });
    },

    duckdb_web_http_post_async__sig: 'ipipipp',
    duckdb_web_http_post_async__async: true,
    duckdb_web_http_post_async: function(urlPtr, urlLen, headersPtr, headersCount, bodyPtr, bodyLen, responsePtr) {
        return Asyncify.handleAsync(async () => {
            return await globalThis.DUCKDB_RUNTIME.httpPostAsync(
                Module, urlPtr, urlLen, headersPtr, headersCount, bodyPtr, bodyLen, responsePtr
            );
        });
    },

    duckdb_web_http_put_async__sig: 'ipipipp',
    duckdb_web_http_put_async__async: true,
    duckdb_web_http_put_async: function(urlPtr, urlLen, headersPtr, headersCount, bodyPtr, bodyLen, responsePtr) {
        return Asyncify.handleAsync(async () => {
            return await globalThis.DUCKDB_RUNTIME.httpPutAsync(
                Module, urlPtr, urlLen, headersPtr, headersCount, bodyPtr, bodyLen, responsePtr
            );
        });
    },

    duckdb_web_http_delete_async__sig: 'ipiipp',
    duckdb_web_http_delete_async__async: true,
    duckdb_web_http_delete_async: function(urlPtr, urlLen, headersPtr, headersCount, responsePtr) {
        return Asyncify.handleAsync(async () => {
            return await globalThis.DUCKDB_RUNTIME.httpDeleteAsync(
                Module, urlPtr, urlLen, headersPtr, headersCount, responsePtr
            );
        });
    },
```

**Estimated Hours**: 3-4

**Dependencies**: Task 1 (needs Asyncify enabled)

---

### Task 3: Modify http_wasm.cc for Asyncify-Compatible Calls

**File**: `/Users/nathanclevenger/projects/pocs/packages/duckdb-wasm-fork/lib/src/http_wasm.cc`

**Current Architecture Problem**:
The current code uses `EM_ASM_PTR` which embeds JavaScript directly in C++. This inline JavaScript uses synchronous XHR. We need to replace this with external function calls that can be marked as async imports.

**Header Additions** (add after line 9):
```cpp
// Asyncify HTTP function declarations
// These are implemented in js-stubs.js and can yield to async JavaScript
extern "C" {
    // Returns status code, writes response data to responsePtr
    int duckdb_web_http_fetch_async(
        const char* url, size_t url_len,
        const char* headers_json, size_t headers_count,
        void* response_ptr
    );

    int duckdb_web_http_head_async(
        const char* url, size_t url_len,
        const char* headers_json, size_t headers_count,
        void* response_ptr
    );

    int duckdb_web_http_post_async(
        const char* url, size_t url_len,
        const char* headers_json, size_t headers_count,
        const char* body, size_t body_len,
        void* response_ptr
    );

    int duckdb_web_http_put_async(
        const char* url, size_t url_len,
        const char* headers_json, size_t headers_count,
        const char* body, size_t body_len,
        void* response_ptr
    );

    int duckdb_web_http_delete_async(
        const char* url, size_t url_len,
        const char* headers_json, size_t headers_count,
        void* response_ptr
    );
}
```

**Replace HTTPWasmClient::Get Method** (lines 22-166):

**Current** (simplified):
```cpp
unique_ptr<HTTPResponse> Get(GetRequestInfo &info) override {
    // ... URL preparation ...
    char *exe = (char *)EM_ASM_PTR({
        const xhr = new XMLHttpRequest();
        xhr.open("GET", url, false);  // SYNCHRONOUS
        xhr.send(null);
        // ... handle response ...
    }, path.c_str(), n, z, "GET");
    // ... process response ...
}
```

**New Implementation**:
```cpp
unique_ptr<HTTPResponse> Get(GetRequestInfo &info) override {
    unique_ptr<HTTPResponse> res;

    string path = info.url;
    if (path[0] == '/') path = host_port + info.url;

    // Apply S3 proxy if configured
    if (!web::experimental_s3_tables_global_proxy.empty()) {
        // ... existing S3 proxy logic ...
    }

    // Ensure HTTPS
    if ((path.rfind("https://", 0) != 0) && (path.rfind("http://", 0) != 0)) {
        path = "https://" + path;
    }

    // Serialize headers to JSON for transfer to JavaScript
    std::string headers_json = "[";
    bool first = true;
    for (const auto& h : info.headers) {
        if (!first) headers_json += ",";
        first = false;
        headers_json += "{\"name\":\"" + h.first + "\",\"value\":\"" + h.second + "\"}";
    }
    headers_json += "]";

    // Response structure in WASM memory
    // Layout: [status:4][body_len:4][body_ptr:4][headers_ptr:4]
    struct AsyncResponse {
        int32_t status;
        int32_t body_len;
        void* body_ptr;
        void* headers_ptr;
    };
    AsyncResponse response = {0, 0, nullptr, nullptr};

    // Call async fetch - this yields to JavaScript via Asyncify
    int status = duckdb_web_http_fetch_async(
        path.c_str(), path.size(),
        headers_json.c_str(), info.headers.size(),
        &response
    );

    if (status >= 400 || status == 0) {
        res = make_uniq<HTTPResponse>(HTTPStatusCode::NotFound_404);
        res->reason = "HTTP request failed";
    } else {
        res = make_uniq<HTTPResponse>(HTTPStatusCode::OK_200);
        if (response.body_ptr && response.body_len > 0) {
            res->body = string(static_cast<char*>(response.body_ptr), response.body_len);
            if (info.content_handler) {
                info.content_handler(
                    static_cast<const unsigned char*>(response.body_ptr),
                    response.body_len
                );
            }
            free(response.body_ptr);
        }
    }

    return res;
}
```

**Apply similar changes to**: `Head()`, `Post()`, `Put()`, `Delete()` methods.

**Estimated Hours**: 8-12

**Dependencies**: Task 2 (needs js-stubs.js with Asyncify handlers)

---

### Task 4: Create runtime_workers.ts (New File)

**File**: `/Users/nathanclevenger/projects/pocs/packages/duckdb-wasm-fork/packages/duckdb-wasm/src/bindings/runtime_workers.ts`

**Purpose**: Workers-compatible runtime using async `fetch()` instead of sync XHR.

**Full Implementation**:

```typescript
/**
 * DuckDB-WASM Runtime for Cloudflare Workers and Web Workers
 *
 * This runtime uses async fetch() instead of synchronous XMLHttpRequest,
 * compatible with environments that don't support sync XHR.
 *
 * Requires: DuckDB-WASM built with -sASYNCIFY flag
 */

import { StatusCode } from '../status';
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

// Response structure matching C++ AsyncResponse
interface HttpAsyncResponse {
    status: number;
    body: Uint8Array | null;
    headers: Map<string, string>;
}

/**
 * Parse headers from WASM memory
 */
function parseHeadersFromPointer(mod: DuckDBModule, ptr: number, count: number): Map<string, string> {
    const headers = new Map<string, string>();
    // Headers are stored as null-terminated string pairs
    // Implementation depends on serialization format
    return headers;
}

/**
 * Serialize headers array for fetch
 */
function serializeHeaders(headers: Array<{name: string, value: string}>): Headers {
    const result = new Headers();
    for (const h of headers) {
        // Handle special headers that browsers restrict
        let name = h.name;
        if (name === 'Host') name = 'X-Host-Override';
        if (name === 'User-Agent') name = 'X-User-Agent';
        result.set(name, h.value);
    }
    return result;
}

/**
 * Write response data to WASM memory
 */
function writeResponseToMemory(
    mod: DuckDBModule,
    responsePtr: number,
    response: HttpAsyncResponse
): void {
    // Response layout: [status:i32][body_len:i32][body_ptr:i32][headers_ptr:i32]
    const view = new DataView(mod.HEAPU8.buffer, responsePtr, 16);

    view.setInt32(0, response.status, true);

    if (response.body && response.body.length > 0) {
        const bodyPtr = mod._malloc(response.body.length);
        mod.HEAPU8.set(response.body, bodyPtr);
        view.setInt32(4, response.body.length, true);
        view.setInt32(8, bodyPtr, true);
    } else {
        view.setInt32(4, 0, true);
        view.setInt32(8, 0, true);
    }

    view.setInt32(12, 0, true); // headers_ptr - not implemented yet
}

export const WORKERS_RUNTIME: DuckDBRuntime & {
    _files: Map<string, any>;
    _fileInfoCache: Map<number, DuckDBFileInfo>;
    _globalFileInfo: DuckDBGlobalFileInfo | null;

    getFileInfo(mod: DuckDBModule, fileId: number): DuckDBFileInfo | null;
    getGlobalFileInfo(mod: DuckDBModule): DuckDBGlobalFileInfo | null;

    // Async HTTP methods called from js-stubs.js via Asyncify
    httpFetchAsync(
        mod: DuckDBModule,
        urlPtr: number, urlLen: number,
        headersPtr: number, headersCount: number,
        responsePtr: number
    ): Promise<number>;

    httpHeadAsync(
        mod: DuckDBModule,
        urlPtr: number, urlLen: number,
        headersPtr: number, headersCount: number,
        responsePtr: number
    ): Promise<number>;

    httpPostAsync(
        mod: DuckDBModule,
        urlPtr: number, urlLen: number,
        headersPtr: number, headersCount: number,
        bodyPtr: number, bodyLen: number,
        responsePtr: number
    ): Promise<number>;

    httpPutAsync(
        mod: DuckDBModule,
        urlPtr: number, urlLen: number,
        headersPtr: number, headersCount: number,
        bodyPtr: number, bodyLen: number,
        responsePtr: number
    ): Promise<number>;

    httpDeleteAsync(
        mod: DuckDBModule,
        urlPtr: number, urlLen: number,
        headersPtr: number, headersCount: number,
        responsePtr: number
    ): Promise<number>;
} = {
    _files: new Map<string, any>(),
    _fileInfoCache: new Map<number, DuckDBFileInfo>(),
    _udfFunctions: new Map(),
    _globalFileInfo: null,

    // ==========================================================================
    // ASYNC HTTP METHODS - Called from js-stubs.js via Asyncify
    // ==========================================================================

    async httpFetchAsync(
        mod: DuckDBModule,
        urlPtr: number, urlLen: number,
        headersPtr: number, headersCount: number,
        responsePtr: number
    ): Promise<number> {
        try {
            const url = readString(mod, urlPtr, urlLen);
            const headers = parseHeadersFromPointer(mod, headersPtr, headersCount);

            const response = await fetch(url, {
                method: 'GET',
                headers: Object.fromEntries(headers),
            });

            const body = new Uint8Array(await response.arrayBuffer());

            writeResponseToMemory(mod, responsePtr, {
                status: response.status,
                body,
                headers: new Map(response.headers.entries()),
            });

            return response.status;
        } catch (error) {
            console.error('httpFetchAsync error:', error);
            return 0;
        }
    },

    async httpHeadAsync(
        mod: DuckDBModule,
        urlPtr: number, urlLen: number,
        headersPtr: number, headersCount: number,
        responsePtr: number
    ): Promise<number> {
        try {
            const url = readString(mod, urlPtr, urlLen);
            const headers = parseHeadersFromPointer(mod, headersPtr, headersCount);

            const response = await fetch(url, {
                method: 'HEAD',
                headers: Object.fromEntries(headers),
            });

            writeResponseToMemory(mod, responsePtr, {
                status: response.status,
                body: null,
                headers: new Map(response.headers.entries()),
            });

            return response.status;
        } catch (error) {
            console.error('httpHeadAsync error:', error);
            return 0;
        }
    },

    async httpPostAsync(
        mod: DuckDBModule,
        urlPtr: number, urlLen: number,
        headersPtr: number, headersCount: number,
        bodyPtr: number, bodyLen: number,
        responsePtr: number
    ): Promise<number> {
        try {
            const url = readString(mod, urlPtr, urlLen);
            const headers = parseHeadersFromPointer(mod, headersPtr, headersCount);
            const body = mod.HEAPU8.slice(bodyPtr, bodyPtr + bodyLen);

            const response = await fetch(url, {
                method: 'POST',
                headers: Object.fromEntries(headers),
                body,
            });

            const responseBody = new Uint8Array(await response.arrayBuffer());

            writeResponseToMemory(mod, responsePtr, {
                status: response.status,
                body: responseBody,
                headers: new Map(response.headers.entries()),
            });

            return response.status;
        } catch (error) {
            console.error('httpPostAsync error:', error);
            return 0;
        }
    },

    async httpPutAsync(
        mod: DuckDBModule,
        urlPtr: number, urlLen: number,
        headersPtr: number, headersCount: number,
        bodyPtr: number, bodyLen: number,
        responsePtr: number
    ): Promise<number> {
        try {
            const url = readString(mod, urlPtr, urlLen);
            const headers = parseHeadersFromPointer(mod, headersPtr, headersCount);
            const body = mod.HEAPU8.slice(bodyPtr, bodyPtr + bodyLen);

            const response = await fetch(url, {
                method: 'PUT',
                headers: Object.fromEntries(headers),
                body,
            });

            writeResponseToMemory(mod, responsePtr, {
                status: response.status,
                body: null,
                headers: new Map(response.headers.entries()),
            });

            return response.status;
        } catch (error) {
            console.error('httpPutAsync error:', error);
            return 0;
        }
    },

    async httpDeleteAsync(
        mod: DuckDBModule,
        urlPtr: number, urlLen: number,
        headersPtr: number, headersCount: number,
        responsePtr: number
    ): Promise<number> {
        try {
            const url = readString(mod, urlPtr, urlLen);
            const headers = parseHeadersFromPointer(mod, headersPtr, headersCount);

            const response = await fetch(url, {
                method: 'DELETE',
                headers: Object.fromEntries(headers),
            });

            const body = new Uint8Array(await response.arrayBuffer());

            writeResponseToMemory(mod, responsePtr, {
                status: response.status,
                body,
                headers: new Map(response.headers.entries()),
            });

            return response.status;
        } catch (error) {
            console.error('httpDeleteAsync error:', error);
            return 0;
        }
    },

    // ==========================================================================
    // FILE INFO METHODS (same as browser runtime)
    // ==========================================================================

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
                return cached!;
            }
            const infoStr = readString(mod, d, n);
            dropResponseBuffers(mod);
            try {
                const info = JSON.parse(infoStr);
                if (info == null) return null;
                const file = { ...info, blob: null } as DuckDBFileInfo;
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
                return WORKERS_RUNTIME._globalFileInfo!;
            }
            const infoStr = readString(mod, d, n);
            dropResponseBuffers(mod);
            const info = JSON.parse(infoStr);
            if (info == null) return null;
            WORKERS_RUNTIME._globalFileInfo = { ...info } as DuckDBGlobalFileInfo;
            return WORKERS_RUNTIME._globalFileInfo;
        } catch (e: any) {
            console.log(e);
            return null;
        }
    },

    // ==========================================================================
    // STANDARD RUNTIME INTERFACE (simplified for Workers)
    // ==========================================================================

    testPlatformFeature: (_mod: DuckDBModule, feature: number): boolean => {
        switch (feature) {
            case 1:
                return typeof BigInt64Array !== 'undefined';
            default:
                return false;
        }
    },

    getDefaultDataProtocol(_mod: DuckDBModule): number {
        return DuckDBDataProtocol.HTTP;
    },

    openFile: (mod: DuckDBModule, fileId: number, flags: FileFlags): number => {
        const file = WORKERS_RUNTIME.getFileInfo(mod, fileId);
        if (!file) return 0;

        switch (file.dataProtocol) {
            case DuckDBDataProtocol.HTTP:
            case DuckDBDataProtocol.S3:
                // HTTP files don't need special handling here
                // The async fetch will be called during read operations
                const result = mod._malloc(3 * 8);
                mod.HEAPF64[(result >> 3) + 0] = 0; // Size unknown until fetched
                mod.HEAPF64[(result >> 3) + 1] = 0;
                mod.HEAPF64[(result >> 3) + 2] = 0;
                return result;
            default:
                console.warn(`Unsupported protocol in Workers: ${file.dataProtocol}`);
                return 0;
        }
    },

    syncFile: (_mod: DuckDBModule, _fileId: number) => {},
    closeFile: (mod: DuckDBModule, fileId: number) => {
        WORKERS_RUNTIME._fileInfoCache.delete(fileId);
    },
    dropFile: (_mod: DuckDBModule, _fileNamePtr: number, _fileNameLen: number) => {},

    getLastFileModificationTime: (_mod: DuckDBModule, _fileId: number): number => {
        return Date.now() / 1000;
    },

    truncateFile: (mod: DuckDBModule, _fileId: number, _newSize: number) => {
        failWith(mod, 'truncateFile not supported in Workers runtime');
    },

    readFile(mod: DuckDBModule, fileId: number, buf: number, bytes: number, location: number): number {
        // Note: This is called synchronously from C++, but the HTTP fetch
        // happens via the Asyncify path in httpFetchAsync
        const file = WORKERS_RUNTIME.getFileInfo(mod, fileId);
        if (!file) return 0;

        // For HTTP files, this should not be called directly
        // The C++ HTTP client calls the async HTTP functions instead
        console.warn('readFile called in Workers runtime - this should use async HTTP');
        return 0;
    },

    writeFile: (mod: DuckDBModule, _fileId: number, _buf: number, _bytes: number, _location: number) => {
        failWith(mod, 'writeFile not implemented in Workers runtime');
        return 0;
    },

    glob: (mod: DuckDBModule, pathPtr: number, pathLen: number) => {
        const path = readString(mod, pathPtr, pathLen);
        // In Workers, we can only glob HTTP resources by checking if they exist
        if (path.startsWith('http') || path.startsWith('s3://')) {
            mod.ccall('duckdb_web_fs_glob_add_path', null, ['string'], [path]);
        }
    },

    checkFile: (mod: DuckDBModule, pathPtr: number, pathLen: number): boolean => {
        const path = readString(mod, pathPtr, pathLen);
        // Note: This would need to be async in practice
        return path.startsWith('http') || path.startsWith('s3://');
    },

    checkDirectory: (_mod: DuckDBModule, _pathPtr: number, _pathLen: number): boolean => false,
    createDirectory: (_mod: DuckDBModule, _pathPtr: number, _pathLen: number) => {},
    removeDirectory: (_mod: DuckDBModule, _pathPtr: number, _pathLen: number) => {},
    listDirectoryEntries: (_mod: DuckDBModule, _pathPtr: number, _pathLen: number): boolean => false,
    moveFile: (_mod: DuckDBModule, _fromPtr: number, _fromLen: number, _toPtr: number, _toLen: number) => {},
    removeFile: (_mod: DuckDBModule, _pathPtr: number, _pathLen: number) => {},

    progressUpdate: (_done: number, _percentage: number, _repeat: number): void => {},

    callScalarUDF: (
        mod: DuckDBModule,
        response: number,
        funcId: number,
        descPtr: number,
        descSize: number,
        ptrsPtr: number,
        ptrsSize: number,
    ): void => {
        udf.callScalarUDF(WORKERS_RUNTIME, mod, response, funcId, descPtr, descSize, ptrsPtr, ptrsSize);
    },
};

export default WORKERS_RUNTIME;
```

**Estimated Hours**: 6-8

**Dependencies**: Tasks 1, 2, 3

---

### Task 5: Update wasm_build_lib.sh for Asyncify Builds

**File**: `/Users/nathanclevenger/projects/pocs/packages/duckdb-wasm-fork/scripts/wasm_build_lib.sh`

**Add after line 44**:
```bash
case $FEATURES in
  # ... existing cases ...
  "asyncify")
    ADDITIONAL_FLAGS="${ADDITIONAL_FLAGS} -DWITH_ASYNCIFY=1 -DDUCKDB_CUSTOM_PLATFORM=wasm_asyncify -DDUCKDB_EXPLICIT_PLATFORM=wasm_asyncify"
    SUFFIX="-asyncify"
    ;;
   *) ;;
esac
```

**Estimated Hours**: 1

**Dependencies**: Task 1

---

### Task 6: Create Cloudflare Workers Bindings

**File**: `/Users/nathanclevenger/projects/pocs/packages/duckdb-wasm-fork/packages/duckdb-wasm/src/bindings/bindings_cloudflare.ts`

```typescript
/**
 * DuckDB bindings for Cloudflare Workers
 *
 * This is a specialized binding that uses the Workers runtime with Asyncify.
 */

import { DuckDBModule } from './duckdb_module';
import { DuckDBBindingsBase } from './bindings_base';
import { Logger } from '../log';
import WORKERS_RUNTIME from './runtime_workers';

export class DuckDBCloudflareBindings extends DuckDBBindingsBase {
    protected readonly wasmModule: WebAssembly.Module;

    constructor(logger: Logger, wasmModule: WebAssembly.Module) {
        super(logger, WORKERS_RUNTIME);
        this.wasmModule = wasmModule;
    }

    protected async instantiateImpl(moduleOverrides: Partial<DuckDBModule>): Promise<DuckDBModule> {
        globalThis.DUCKDB_RUNTIME = this._runtime;

        // Import the DuckDB module factory
        const DuckDB = await import('../bindings/duckdb-asyncify.js');

        return new Promise((resolve, reject) => {
            const module = DuckDB.default({
                ...moduleOverrides,
                instantiateWasm: (
                    imports: WebAssembly.Imports,
                    successCallback: (instance: WebAssembly.Instance) => void
                ) => {
                    WebAssembly.instantiate(this.wasmModule, imports)
                        .then(instance => {
                            successCallback(instance);
                        })
                        .catch(reject);
                    return {};
                },
            });

            module.then(resolve).catch(reject);
        });
    }
}
```

**Estimated Hours**: 3-4

**Dependencies**: Tasks 4, 5

---

### Task 7: Export and Integration

**File**: `/Users/nathanclevenger/projects/pocs/packages/duckdb-wasm-fork/packages/duckdb-wasm/src/bindings/index.ts`

**Add exports**:
```typescript
export { WORKERS_RUNTIME } from './runtime_workers';
export { DuckDBCloudflareBindings } from './bindings_cloudflare';
```

**File**: `/Users/nathanclevenger/projects/pocs/packages/duckdb-wasm-fork/packages/duckdb-wasm/src/index.ts`

**Add re-exports** for the new Cloudflare/Workers support.

**Estimated Hours**: 1-2

**Dependencies**: Tasks 4, 6

---

## 4. Risk Assessment

### High Risk

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Asyncify increases WASM size significantly (2-3x) | High | High | Create separate asyncify build, measure size impact |
| Performance degradation from stack unwinding | Medium | High | Benchmark critical paths, optimize hot functions |
| Asyncify stack overflow on deep call stacks | Medium | High | Increase ASYNCIFY_STACK_SIZE, test with large queries |

### Medium Risk

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Memory leaks from async response handling | Medium | Medium | Careful malloc/free pairing, test with leak detectors |
| Header serialization edge cases | Low | Medium | Comprehensive header parsing tests |
| S3 authentication timing issues | Low | Medium | Test with various S3 configurations |

### Low Risk

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Browser compatibility | Low | Low | Keep browser runtime unchanged, new runtime is additive |
| Build system complexity | Low | Low | Clear documentation, CI/CD integration |

---

## 5. Test Strategy

### Unit Tests

**File**: `/packages/duckdb-wasm/test/asyncify.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { WORKERS_RUNTIME } from '../src/bindings/runtime_workers';

describe('Workers Runtime', () => {
    describe('HTTP Async Functions', () => {
        it('should fetch HTTP resource', async () => {
            // Mock DuckDBModule
            const mockMod = createMockModule();

            // Test httpFetchAsync
            const status = await WORKERS_RUNTIME.httpFetchAsync(
                mockMod,
                /* urlPtr */ 0, /* urlLen */ 10,
                /* headersPtr */ 0, /* headersCount */ 0,
                /* responsePtr */ 0
            );

            expect(status).toBeGreaterThan(0);
        });

        it('should handle fetch errors gracefully', async () => {
            // Test with invalid URL
        });
    });

    describe('Memory Management', () => {
        it('should not leak memory on successful fetch', () => {
            // Track malloc/free calls
        });

        it('should free memory on failed fetch', () => {
            // Verify cleanup on error
        });
    });
});
```

### Integration Tests

**File**: `/packages/duckdb-wasm/test/cloudflare-integration.test.ts`

```typescript
describe('Cloudflare Workers Integration', () => {
    it('should query remote Parquet file', async () => {
        const bindings = await createAsyncifyBindings();
        const db = await bindings.instantiate();

        // Query a remote Parquet file
        const result = await db.query(`
            SELECT * FROM read_parquet('https://example.com/test.parquet')
            LIMIT 10
        `);

        expect(result.numRows).toBe(10);
    });

    it('should handle S3 authentication', async () => {
        // Test S3 with credentials
    });
});
```

### End-to-End Tests

**File**: `/packages/duckdb-wasm/test/e2e/workers.test.ts`

Use Miniflare or Wrangler to test in actual Workers environment:

```typescript
import { Miniflare } from 'miniflare';

describe('Workers E2E', () => {
    let mf: Miniflare;

    beforeAll(async () => {
        mf = new Miniflare({
            script: `
                import { DuckDBCloudflareBindings } from '@duckdb/duckdb-wasm';

                export default {
                    async fetch(request) {
                        const bindings = new DuckDBCloudflareBindings(console, wasmModule);
                        const db = await bindings.instantiate();
                        const result = await db.query("SELECT 1 + 1 as result");
                        return new Response(JSON.stringify(result));
                    }
                }
            `,
            modules: true,
        });
    });

    it('should execute query in Worker', async () => {
        const resp = await mf.dispatchFetch('http://localhost/');
        const data = await resp.json();
        expect(data.result).toBe(2);
    });
});
```

### Performance Benchmarks

Create benchmarks comparing:
1. Browser runtime (sync XHR)
2. Workers runtime (async fetch via Asyncify)
3. Node.js runtime (fs operations)

---

## 6. Build & Deployment

### New Build Targets

Add to `Makefile`:

```makefile
# Build with Asyncify for Cloudflare Workers
.PHONY: wasm_asyncify
wasm_asyncify: wasm_setup
	${EXEC_ENVIRONMENT} ${ROOT_DIR}/scripts/wasm_build_lib.sh relperf asyncify

# Build all Workers-compatible variants
.PHONY: wasm_workers
wasm_workers: wasm_asyncify
```

### Build Commands

```bash
# Development build with Asyncify
make wasm_asyncify

# Or manual build:
./scripts/wasm_build_lib.sh relperf asyncify

# Build TypeScript
yarn workspace @duckdb/duckdb-wasm build:release
```

### Output Files

After build, these files will be created:
- `packages/duckdb-wasm/src/bindings/duckdb-asyncify.wasm` (~15-25 MB with Asyncify)
- `packages/duckdb-wasm/src/bindings/duckdb-asyncify.js`

### Package Publishing

Update `package.json` to include new entry points:

```json
{
  "exports": {
    ".": "./dist/index.js",
    "./cloudflare": "./dist/bindings/bindings_cloudflare.js",
    "./workers": "./dist/bindings/runtime_workers.js"
  }
}
```

---

## 7. Timeline

### Phase 1: Core Infrastructure (Week 1)
| Day | Task | Hours |
|-----|------|-------|
| 1-2 | Task 1: CMake Asyncify configuration | 2-3 |
| 2-3 | Task 2: js-stubs.js Asyncify wrappers | 3-4 |
| 3-5 | Task 3: http_wasm.cc modifications | 8-12 |

### Phase 2: TypeScript Runtime (Week 2)
| Day | Task | Hours |
|-----|------|-------|
| 1-3 | Task 4: runtime_workers.ts | 6-8 |
| 3-4 | Task 5: Build script updates | 1 |
| 4-5 | Task 6: Cloudflare bindings | 3-4 |

### Phase 3: Integration & Testing (Week 3)
| Day | Task | Hours |
|-----|------|-------|
| 1-2 | Task 7: Exports and integration | 1-2 |
| 2-4 | Unit and integration tests | 4-6 |
| 4-5 | E2E testing with Miniflare | 3-4 |

### Phase 4: Documentation & Release (Week 4)
| Day | Task | Hours |
|-----|------|-------|
| 1-2 | Documentation | 2-3 |
| 2-3 | Performance benchmarks | 2-3 |
| 3-4 | CI/CD integration | 2-3 |
| 4-5 | Release preparation | 1-2 |

---

## Appendix A: Asyncify Technical Details

### How Asyncify Works

1. **Compilation**: `-sASYNCIFY` instruments all C++ functions with save/restore logic
2. **Import List**: `-sASYNCIFY_IMPORTS` specifies which JS functions can yield
3. **Execution Flow**:
   ```
   C++ code calls duckdb_web_http_fetch_async()
        |
        v
   js-stubs.js wraps call with Asyncify.handleAsync()
        |
        v
   JavaScript async function starts, returns Promise
        |
        v
   Asyncify saves C++ stack state, yields to JS event loop
        |
        v
   Promise resolves (fetch completes)
        |
        v
   Asyncify restores C++ stack, continues execution
   ```

### Stack Size Considerations

The default Asyncify stack is 4KB. For DuckDB with deep query execution stacks, we use 64KB:
```cmake
-sASYNCIFY_STACK_SIZE=65536
```

If stack overflows occur, increase this value but be aware of memory impact.

### Performance Implications

Asyncify adds overhead:
- **Code size**: 2-3x increase in WASM binary size
- **Runtime**: Small overhead per function call for instrumentation
- **Memory**: Asyncify stack allocation

For DuckDB-WASM, the main performance-critical paths (query execution, aggregation) don't cross async boundaries, so impact should be minimal.

---

## Appendix B: Alternative Approaches Considered

### 1. SharedArrayBuffer + Atomics (Rejected)
- Would require COOP/COEP headers
- Not supported in all Workers environments
- More complex synchronization

### 2. Comlink/Proxy Pattern (Rejected)
- Would require restructuring DuckDB API
- Higher latency for each operation
- Significant code changes

### 3. Pre-fetching All Data (Rejected)
- Not practical for large datasets
- Defeats purpose of lazy loading
- High memory usage

### 4. Service Worker Proxy (Rejected)
- Adds deployment complexity
- Not available in Cloudflare Workers
- Additional latency

**Conclusion**: Asyncify is the best approach as it requires minimal API changes while enabling true async HTTP support.

---

## Appendix C: File Reference

| File | Purpose | Lines to Modify |
|------|---------|-----------------|
| `lib/CMakeLists.txt` | Build configuration | 284-301 |
| `lib/js-stubs.js` | JS runtime bindings | Full file + additions |
| `lib/src/http_wasm.cc` | C++ HTTP client | Full file refactor |
| `packages/duckdb-wasm/src/bindings/runtime_workers.ts` | New file | N/A |
| `packages/duckdb-wasm/src/bindings/bindings_cloudflare.ts` | New file | N/A |
| `scripts/wasm_build_lib.sh` | Build script | ~30-45 |
| `Makefile` | Build targets | End of file |
