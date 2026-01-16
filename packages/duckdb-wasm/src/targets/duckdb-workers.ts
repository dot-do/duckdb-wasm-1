/**
 * DuckDB-WASM Entry Point for Cloudflare Workers
 *
 * This module provides the DuckDB bindings optimized for Cloudflare Workers environment.
 * It exports the WORKERS_RUNTIME which handles async file operations using fetch().
 *
 * Usage:
 * ```typescript
 * import {
 *     createDuckDB,
 *     WORKERS_RUNTIME,
 *     DuckDBDataProtocol,
 *     ConsoleLogger,
 *     LogLevel
 * } from '@anthropic-pocs/duckdb-wasm/dist/duckdb-workers';
 *
 * // In your Worker's fetch handler:
 * export default {
 *     async fetch(request: Request, env: Env): Promise<Response> {
 *         const logger = new ConsoleLogger(LogLevel.WARNING);
 *
 *         // Option 1: Using pre-compiled WASM module (recommended)
 *         const db = await createDuckDB(
 *             { wasmModule: env.DUCKDB_WASM },  // WASM binding from wrangler.toml
 *             logger,
 *             WORKERS_RUNTIME
 *         );
 *
 *         // Option 2: Using WASM URL
 *         const db = await createDuckDB(
 *             { wasmURL: 'https://example.com/duckdb.wasm' },
 *             logger,
 *             WORKERS_RUNTIME
 *         );
 *
 *         await db.instantiate();
 *         db.open({ path: ':memory:' });
 *
 *         const conn = db.connect();
 *         const result = await conn.query('SELECT 1 as value');
 *         // ... process result
 *     }
 * };
 * ```
 */

// Re-export all common bindings
export * from '../bindings';
export * from '../log';
export * from '../platform';
export * from '../status';
export * from '../version';

// Export runtime-specific items
export { DuckDBDataProtocol } from '../bindings/runtime';
export { DEFAULT_RUNTIME } from '../bindings/runtime';
export { WORKERS_RUNTIME, registerBuffer, getBuffer, clearFileCache } from '../bindings/runtime_workers';

// Export Cloudflare-specific bindings
export { DuckDBCloudflareBindings, CloudflareInstantiateConfig } from '../bindings/bindings_cloudflare';
export { DuckDB as DuckDBMVP } from '../bindings/bindings_cloudflare_mvp';
export { DuckDB as DuckDBEH } from '../bindings/bindings_cloudflare_eh';

import { Logger } from '../log';
import { DuckDBRuntime, DuckDBBindings } from '../bindings';
import { DuckDB as DuckDBMVP } from '../bindings/bindings_cloudflare_mvp';
import { DuckDB as DuckDBEH } from '../bindings/bindings_cloudflare_eh';
import { CloudflareInstantiateConfig } from '../bindings/bindings_cloudflare';

/**
 * Configuration for creating DuckDB in Cloudflare Workers
 */
export interface WorkersDuckDBConfig extends CloudflareInstantiateConfig {
    /**
     * Whether to prefer the EH (Exception Handling) build
     * If false or not set, uses MVP build for wider compatibility
     * @default false
     */
    useExceptionHandling?: boolean;
}

/**
 * Create a DuckDB instance for Cloudflare Workers
 *
 * @param config - Configuration including WASM module, URL, or binary
 * @param logger - Logger instance for debug output
 * @param runtime - The Workers runtime (use WORKERS_RUNTIME)
 * @returns Promise resolving to DuckDB bindings instance
 *
 * @example
 * ```typescript
 * // Using pre-compiled WASM module from wrangler binding
 * const db = await createDuckDB(
 *     { wasmModule: env.DUCKDB_WASM },
 *     logger,
 *     WORKERS_RUNTIME
 * );
 *
 * // Using WASM from R2 or external URL
 * const db = await createDuckDB(
 *     { wasmURL: 'https://my-bucket.r2.dev/duckdb-eh.wasm' },
 *     logger,
 *     WORKERS_RUNTIME
 * );
 *
 * // Using ArrayBuffer (e.g., from KV or R2)
 * const wasmBinary = await env.MY_KV.get('duckdb.wasm', 'arrayBuffer');
 * const db = await createDuckDB(
 *     { wasmBinary },
 *     logger,
 *     WORKERS_RUNTIME
 * );
 * ```
 */
export async function createDuckDB(
    config: WorkersDuckDBConfig,
    logger: Logger,
    runtime: DuckDBRuntime,
): Promise<DuckDBBindings> {
    // Use EH build if explicitly requested, otherwise use MVP for compatibility
    if (config.useExceptionHandling) {
        return new DuckDBEH(logger, runtime, config);
    }
    return new DuckDBMVP(logger, runtime, config);
}

/**
 * Create DuckDB with automatic variant selection based on environment
 *
 * This function tries to detect WASM exception support and selects
 * the appropriate build variant automatically.
 *
 * @param config - Configuration including WASM module, URL, or binary
 * @param logger - Logger instance
 * @param runtime - The Workers runtime
 * @returns Promise resolving to DuckDB bindings instance
 */
export async function createDuckDBAuto(
    config: WorkersDuckDBConfig,
    logger: Logger,
    runtime: DuckDBRuntime,
): Promise<DuckDBBindings> {
    // In Cloudflare Workers, we generally have modern WASM support
    // Default to MVP for maximum compatibility unless EH is explicitly requested
    // Future: Could add feature detection here

    if (config.useExceptionHandling !== undefined) {
        return createDuckDB(config, logger, runtime);
    }

    // Default to MVP for compatibility
    return new DuckDBMVP(logger, runtime, config);
}

// Default export for convenience
export default {
    createDuckDB,
    createDuckDBAuto,
};
