/**
 * DuckDB-WASM JavaScript Stubs for Emscripten
 *
 * These functions are called from C++ via Emscripten's addToLibrary().
 * They delegate to globalThis.DUCKDB_RUNTIME which can be:
 *   - BROWSER_RUNTIME (sync XMLHttpRequest)
 *   - NODE_RUNTIME (sync fs operations)
 *   - WORKERS_RUNTIME (async fetch() via Asyncify)
 *
 * For Asyncify mode:
 *   - Functions marked with __async: true will be handled by Asyncify
 *   - When runtime methods return Promises, Asyncify suspends WASM execution
 *   - When the Promise resolves, Asyncify resumes execution
 *
 * Function signature codes (for __sig):
 *   v = void
 *   i = i32 (integer)
 *   p = pointer (i32 in wasm32)
 *   d = f64 (double)
 */
addToLibrary({
    // ==========================================================================
    // PLATFORM FEATURE DETECTION
    // ==========================================================================

    duckdb_web_test_platform_feature__sig: 'ii',
    duckdb_web_test_platform_feature: function (feature) {
        return globalThis.DUCKDB_RUNTIME.testPlatformFeature(Module, feature);
    },

    // ==========================================================================
    // FILE SYSTEM - PROTOCOL & BASIC OPERATIONS
    // ==========================================================================

    duckdb_web_fs_get_default_data_protocol__sig: 'i',
    duckdb_web_fs_get_default_data_protocol: function () {
        return globalThis.DUCKDB_RUNTIME.getDefaultDataProtocol(Module);
    },

    // ==========================================================================
    // FILE SYSTEM - FILE OPERATIONS (Asyncify-compatible)
    //
    // These functions can return Promises when using WORKERS_RUNTIME.
    // Asyncify will automatically detect Promise returns and:
    //   1. Save the WASM stack state
    //   2. Yield to the JavaScript event loop
    //   3. Resume execution when the Promise resolves
    // ==========================================================================

    /**
     * Open a file by ID with specified flags
     * Returns: pointer to file handle info, or 0 on failure
     *
     * For HTTP/S3 files in Workers runtime, this performs async HEAD/GET
     * requests to determine file size and range request support.
     */
    duckdb_web_fs_file_open__sig: 'iii',
    duckdb_web_fs_file_open__async: true,
    duckdb_web_fs_file_open: function (fileId, flags) {
        // Runtime.openFile may return a Promise in Asyncify mode
        // Asyncify will automatically handle suspension/resumption
        return globalThis.DUCKDB_RUNTIME.openFile(Module, fileId, flags);
    },

    /**
     * Sync file to storage (flush)
     * For HTTP files this is typically a no-op
     */
    duckdb_web_fs_file_sync__sig: 'vi',
    duckdb_web_fs_file_sync__async: true,
    duckdb_web_fs_file_sync: function (fileId) {
        return globalThis.DUCKDB_RUNTIME.syncFile(Module, fileId);
    },

    /**
     * Drop (unregister) a file by name
     */
    duckdb_web_fs_file_drop_file__sig: 'vpi',
    duckdb_web_fs_file_drop_file: function (fileName, fileNameLen) {
        return globalThis.DUCKDB_RUNTIME.dropFile(Module, fileName, fileNameLen);
    },

    /**
     * Close a file by ID
     */
    duckdb_web_fs_file_close__sig: 'vi',
    duckdb_web_fs_file_close__async: true,
    duckdb_web_fs_file_close: function (fileId) {
        return globalThis.DUCKDB_RUNTIME.closeFile(Module, fileId);
    },

    /**
     * Truncate file to new size
     */
    duckdb_web_fs_file_truncate__sig: 'vid',
    duckdb_web_fs_file_truncate__async: true,
    duckdb_web_fs_file_truncate: function (fileId, newSize) {
        return globalThis.DUCKDB_RUNTIME.truncateFile(Module, fileId, newSize);
    },

    /**
     * Read bytes from file at specified location
     * Returns: number of bytes read
     *
     * For HTTP/S3 files in Workers runtime, this performs async fetch()
     * with Range headers. Asyncify handles the Promise.
     */
    duckdb_web_fs_file_read__sig: 'iipid',
    duckdb_web_fs_file_read__async: true,
    duckdb_web_fs_file_read: function (fileId, buf, size, location) {
        // Runtime.readFile may return a Promise in Asyncify mode
        // Asyncify will automatically handle suspension/resumption
        return globalThis.DUCKDB_RUNTIME.readFile(Module, fileId, buf, size, location);
    },

    /**
     * Write bytes to file at specified location
     * Returns: number of bytes written
     *
     * For S3 files in Workers runtime, this performs async fetch() PUT.
     * Asyncify handles the Promise.
     */
    duckdb_web_fs_file_write__sig: 'iipid',
    duckdb_web_fs_file_write__async: true,
    duckdb_web_fs_file_write: function (fileId, buf, size, location) {
        // Runtime.writeFile may return a Promise in Asyncify mode
        // Asyncify will automatically handle suspension/resumption
        return globalThis.DUCKDB_RUNTIME.writeFile(Module, fileId, buf, size, location);
    },

    /**
     * Get last modification time of file
     * Returns: timestamp as double (seconds since epoch)
     */
    duckdb_web_fs_file_get_last_modified_time__sig: 'di',
    duckdb_web_fs_file_get_last_modified_time: function (fileId) {
        return globalThis.DUCKDB_RUNTIME.getLastFileModificationTime(Module, fileId);
    },

    // ==========================================================================
    // FILE SYSTEM - DIRECTORY OPERATIONS
    // ==========================================================================

    /**
     * Check if directory exists at path
     * Returns: boolean
     */
    duckdb_web_fs_directory_exists__sig: 'ipi',
    duckdb_web_fs_directory_exists__async: true,
    duckdb_web_fs_directory_exists: function (path, pathLen) {
        return globalThis.DUCKDB_RUNTIME.checkDirectory(Module, path, pathLen);
    },

    /**
     * Create directory at path
     */
    duckdb_web_fs_directory_create__sig: 'vpi',
    duckdb_web_fs_directory_create__async: true,
    duckdb_web_fs_directory_create: function (path, pathLen) {
        return globalThis.DUCKDB_RUNTIME.createDirectory(Module, path, pathLen);
    },

    /**
     * Remove directory at path
     */
    duckdb_web_fs_directory_remove__sig: 'vpi',
    duckdb_web_fs_directory_remove__async: true,
    duckdb_web_fs_directory_remove: function (path, pathLen) {
        return globalThis.DUCKDB_RUNTIME.removeDirectory(Module, path, pathLen);
    },

    /**
     * List files in directory
     * Returns: boolean indicating success
     */
    duckdb_web_fs_directory_list_files__sig: 'ipi',
    duckdb_web_fs_directory_list_files__async: true,
    duckdb_web_fs_directory_list_files: function (path, pathLen) {
        return globalThis.DUCKDB_RUNTIME.listDirectoryEntries(Module, path, pathLen);
    },

    // ==========================================================================
    // FILE SYSTEM - PATH OPERATIONS (Asyncify-compatible)
    // ==========================================================================

    /**
     * Glob pattern matching for file paths
     *
     * For HTTP/S3 URLs in Workers runtime, this performs async HEAD/GET
     * requests to check file existence. Asyncify handles the Promise.
     */
    duckdb_web_fs_glob__sig: 'vpi',
    duckdb_web_fs_glob__async: true,
    duckdb_web_fs_glob: function (path, pathLen) {
        // Runtime.glob may return a Promise in Asyncify mode
        // Asyncify will automatically handle suspension/resumption
        return globalThis.DUCKDB_RUNTIME.glob(Module, path, pathLen);
    },

    /**
     * Move/rename file from one path to another
     */
    duckdb_web_fs_file_move__sig: 'vpipi',
    duckdb_web_fs_file_move__async: true,
    duckdb_web_fs_file_move: function (from, fromLen, to, toLen) {
        return globalThis.DUCKDB_RUNTIME.moveFile(Module, from, fromLen, to, toLen);
    },

    /**
     * Check if file exists at path
     * Returns: boolean
     *
     * For HTTP/S3 URLs in Workers runtime, this performs async HEAD
     * request. Asyncify handles the Promise.
     */
    duckdb_web_fs_file_exists__sig: 'ipi',
    duckdb_web_fs_file_exists__async: true,
    duckdb_web_fs_file_exists: function (path, pathLen) {
        // Runtime.checkFile may return a Promise in Asyncify mode
        // Asyncify will automatically handle suspension/resumption
        return globalThis.DUCKDB_RUNTIME.checkFile(Module, path, pathLen);
    },

    /**
     * Remove file at path
     */
    duckdb_web_fs_file_remove__sig: 'vpi',
    duckdb_web_fs_file_remove__async: true,
    duckdb_web_fs_file_remove: function (path, pathLen) {
        return globalThis.DUCKDB_RUNTIME.removeFile(Module, path, pathLen);
    },

    // ==========================================================================
    // USER-DEFINED FUNCTIONS
    // ==========================================================================

    /**
     * Call a scalar UDF function
     */
    duckdb_web_udf_scalar_call__sig: 'vpipipi',
    duckdb_web_udf_scalar_call: function (funcId, descPtr, descSize, ptrsPtr, ptrsSize, response) {
        return globalThis.DUCKDB_RUNTIME.callScalarUDF(Module, funcId, descPtr, descSize, ptrsPtr, ptrsSize, response);
    },
});
