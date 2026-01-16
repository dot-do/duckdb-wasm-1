/**
 * DuckDB EH bindings for Cloudflare Workers
 *
 * Uses the EH (Exception Handling) WASM build with native WASM exceptions.
 * This provides better performance but requires WASM exceptions support.
 */

import DuckDBWasm from './duckdb-eh.js';
import { DuckDBCloudflareBindings, CloudflareInstantiateConfig } from './bindings_cloudflare';
import { DuckDBModule } from './duckdb_module';
import { DuckDBRuntime } from './runtime';
import { Logger } from '../log';

/** DuckDB EH bindings for Cloudflare Workers */
export class DuckDB extends DuckDBCloudflareBindings {
    /** Constructor */
    public constructor(
        logger: Logger,
        runtime: DuckDBRuntime,
        config: CloudflareInstantiateConfig = {},
    ) {
        super(logger, runtime, config);
    }

    /** Instantiate the bindings */
    protected instantiateImpl(moduleOverrides: Partial<DuckDBModule>): Promise<DuckDBModule> {
        return DuckDBWasm({
            ...moduleOverrides,
            instantiateWasm: this.instantiateWasm.bind(this),
            locateFile: this.locateFile.bind(this),
        });
    }
}

export default DuckDB;
