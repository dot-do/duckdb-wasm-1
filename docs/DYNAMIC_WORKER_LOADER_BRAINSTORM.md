# DuckDB-WASM Dynamic Worker Loader Pattern for Cloudflare Workers

**Date**: 2026-01-16
**Author**: Research Team
**Status**: Brainstorm Document

---

## Executive Summary

This document explores strategies for decomposing DuckDB-WASM using a **dynamic worker loader** pattern to overcome Cloudflare Workers' 128MB memory limit. The current DuckDB-WASM asyncify build is 83MB, consuming most of the available memory budget before any data is loaded.

### Key Constraints

| Constraint | Value | Impact |
|------------|-------|--------|
| Worker memory limit | 128 MB | 83MB WASM leaves ~45MB for runtime + data |
| WASM module size (asyncify) | 83 MB | Single monolithic module |
| Standard WASM size (eh) | ~33 MB | Still large, but more manageable |
| Cold start target | < 2 seconds | Large WASM = longer cold starts |
| Request timeout | 30 seconds (default) | Complex queries may timeout |

---

## 1. Lazy-Loading WASM Modules On-Demand

### Concept

Instead of loading the entire 83MB DuckDB WASM upfront, load only the core engine initially, then dynamically load additional capabilities (Parquet reader, JSON parser, etc.) when needed.

### Analysis of DuckDB-WASM Build Structure

From the CMakeLists.txt, DuckDB-WASM is built from these source components:

```
lib/src/
├── arrow_casts.cc              # Arrow type conversion
├── arrow_insert_options.cc     # Arrow insertion
├── arrow_stream_buffer.cc      # Arrow streaming
├── arrow_type_mapping.cc       # Arrow type mapping
├── config.cc                   # Configuration
├── csv_insert_options.cc       # CSV parsing
├── http_wasm.cc                # HTTP client (sync XHR)
├── io/
│   ├── buffered_filesystem.cc  # Buffered I/O
│   ├── file_page_buffer.cc     # Page buffering
│   ├── glob.cc                 # Glob patterns
│   ├── memory_filesystem.cc    # In-memory FS
│   └── web_filesystem.cc       # Web FS abstraction
├── json_*.cc                   # JSON parsing (5 files)
├── udf.cc                      # User-defined functions
├── webdb.cc                    # Core WebDB logic
└── webdb_api.cc                # Public API
```

**Current Separate Libraries:**
```cmake
duckdb_web_parquet    # Parquet extension
duckdb_web_json       # JSON extension (optional)
```

### Approach 1A: Extension-Based Lazy Loading

**How It Would Work:**

```typescript
// Initial load: Core DuckDB (~15-20MB estimated)
import coreDuckDB from './duckdb-core.wasm';

// Lazy-load extensions when first needed
const extensions = {
  parquet: () => import('./duckdb-parquet.wasm'),
  json: () => import('./duckdb-json.wasm'),
  httpfs: () => import('./duckdb-httpfs.wasm'),
};

class LazyDuckDB {
  private loadedExtensions = new Set<string>();

  async query(sql: string) {
    // Detect needed extensions from SQL
    if (sql.includes('read_parquet') && !this.loadedExtensions.has('parquet')) {
      await this.loadExtension('parquet');
    }
    return this.executeQuery(sql);
  }

  async loadExtension(name: string) {
    const ext = await extensions[name]();
    // DuckDB native extension loading mechanism
    await this.db.run(`LOAD '${name}'`);
    this.loadedExtensions.add(name);
  }
}
```

**Pros:**
- Significantly reduces initial memory footprint
- Only loads capabilities actually used
- Aligns with DuckDB's native extension architecture
- Cold start improvement (faster initial load)

**Cons:**
- Requires modifying DuckDB-WASM build to create separate modules
- Extension loading adds latency on first use
- Inter-module communication overhead
- DuckDB's extension ABI may not support dynamic WASM loading cleanly
- Asyncify instrumentation spans the entire binary (can't easily separate)

### Approach 1B: Stub-Based Deferred Loading

**Concept:** Ship a minimal "stub" WASM that includes only the query parser and orchestration logic. The stub delegates actual execution to separate executor modules.

```
┌─────────────────────────────────────────────────────────────────┐
│                       Stub WASM (~5MB)                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐ │
│  │ SQL Parser  │  │ Planner     │  │ Execution Coordinator   │ │
│  └─────────────┘  └─────────────┘  └───────────┬─────────────┘ │
│                                                 │               │
└─────────────────────────────────────────────────┼───────────────┘
                                                  │
         ┌────────────────────────────────────────┼────────────────────┐
         │                                        ▼                    │
         │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
         │  │ Scan Worker  │  │ Agg Worker   │  │ Join Worker  │ ...  │
         │  │ (~20MB)      │  │ (~15MB)      │  │ (~25MB)      │      │
         │  └──────────────┘  └──────────────┘  └──────────────┘      │
         │                   Executor Pool                             │
         └─────────────────────────────────────────────────────────────┘
```

**Pros:**
- Most aggressive memory reduction
- Could scale executor workers horizontally
- Parser/planner can run in minimal memory

**Cons:**
- Requires deep DuckDB architecture changes
- Not how DuckDB is designed internally
- Massive implementation effort (months)
- Execution state sharing is complex

**Verdict:** Theoretically elegant but impractical. DuckDB's vectorized execution engine is tightly coupled.

---

## 2. Loader Worker with R2/KV Caching

### Concept

A dedicated "loader" worker fetches, caches, and serves WASM modules from R2 or KV storage. Query workers request modules on-demand.

### Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Request Router                               │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
┌───────────────┐       ┌───────────────┐       ┌───────────────┐
│ Query Worker  │       │ Query Worker  │       │ Query Worker  │
│ (lightweight) │       │ (lightweight) │       │ (lightweight) │
└───────┬───────┘       └───────┬───────┘       └───────┬───────┘
        │                       │                       │
        └───────────────────────┼───────────────────────┘
                                │
                    ┌───────────▼───────────┐
                    │    Loader Worker      │
                    │  ┌─────────────────┐  │
                    │  │   WASM Cache    │  │
                    │  │   (in-memory)   │  │
                    │  └────────┬────────┘  │
                    │           │           │
                    └───────────┼───────────┘
                                │
                    ┌───────────▼───────────┐
                    │         R2            │
                    │  ┌─────────────────┐  │
                    │  │ duckdb-core.wasm│  │
                    │  │ duckdb-ext.wasm │  │
                    │  └─────────────────┘  │
                    └───────────────────────┘
```

### Implementation Sketch

**Loader Worker (Service Binding):**

```typescript
// loader-worker.ts
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const moduleName = url.pathname.slice(1); // e.g., "duckdb-core"

    // Check in-memory cache first
    const cached = moduleCache.get(moduleName);
    if (cached) {
      return new Response(cached, {
        headers: { 'Content-Type': 'application/wasm' }
      });
    }

    // Fetch from R2
    const r2Object = await env.WASM_BUCKET.get(`${moduleName}.wasm`);
    if (!r2Object) {
      return new Response('Module not found', { status: 404 });
    }

    const wasmBytes = await r2Object.arrayBuffer();

    // Cache for subsequent requests (within worker lifetime)
    moduleCache.set(moduleName, wasmBytes);

    return new Response(wasmBytes, {
      headers: {
        'Content-Type': 'application/wasm',
        'Cache-Control': 'public, max-age=31536000' // Immutable
      }
    });
  }
};

// Module cache (per-isolate)
const moduleCache = new Map<string, ArrayBuffer>();
```

**Query Worker using Loader:**

```typescript
// query-worker.ts
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Fetch WASM from loader (service binding)
    const wasmResponse = await env.LOADER.fetch('http://loader/duckdb-asyncify');
    const wasmBytes = await wasmResponse.arrayBuffer();

    // Compile and instantiate
    const module = await WebAssembly.compile(wasmBytes);
    const instance = await WebAssembly.instantiate(module, imports);

    // Execute query
    const result = await executeQuery(instance, request);
    return Response.json(result);
  }
};
```

### Cloudflare KV Alternative

```typescript
// Using KV for faster edge caching
async function getWasmModule(env: Env, name: string): Promise<ArrayBuffer> {
  // KV has a 25MB value limit - won't work for full DuckDB
  // But could work for split modules
  const kvKey = `wasm:${name}:v1`;

  const cached = await env.WASM_KV.get(kvKey, 'arrayBuffer');
  if (cached) return cached;

  const r2Object = await env.WASM_R2.get(`${name}.wasm`);
  const bytes = await r2Object.arrayBuffer();

  // Cache in KV (if under 25MB)
  if (bytes.byteLength < 25 * 1024 * 1024) {
    await env.WASM_KV.put(kvKey, bytes);
  }

  return bytes;
}
```

**Pros:**
- Decouples WASM storage from query execution
- R2 provides durable, versioned storage
- KV provides edge caching for smaller modules
- Can version modules independently
- Supports A/B testing different WASM builds

**Cons:**
- Additional network latency to fetch WASM
- R2 egress costs for frequent fetches
- Still need to fit entire module in query worker memory
- KV 25MB limit rules out full DuckDB caching

**Key Insight:** This pattern helps with deployment and versioning, but doesn't solve the memory limit problem if the full WASM still needs to be instantiated in a single worker.

---

## 3. Splitting DuckDB into Separate WASM Modules

### Concept

Compile DuckDB into functionally independent WASM modules that communicate via shared memory, message passing, or service bindings.

### Potential Module Boundaries

Based on DuckDB architecture and the fork's code:

| Module | Responsibility | Est. Size | Dependencies |
|--------|----------------|-----------|--------------|
| **Parser** | SQL parsing, AST | ~3MB | None |
| **Planner** | Query optimization | ~8MB | Parser |
| **Catalog** | Schema management | ~5MB | Parser |
| **Storage** | Buffer pool, I/O | ~10MB | None |
| **Executor Core** | Vectorized engine | ~25MB | All above |
| **Parquet** | Parquet read/write | ~15MB | Storage |
| **HTTP/S3** | Remote file access | ~5MB | Storage |
| **Arrow** | Arrow serialization | ~10MB | None |

### Approach 3A: Emscripten Dynamic Linking

Emscripten supports dynamic linking via the `-s MAIN_MODULE=1` / `-s SIDE_MODULE=1` flags:

```cmake
# Main module (core engine)
add_executable(duckdb_core ...)
set_target_properties(duckdb_core PROPERTIES
    LINK_FLAGS "-s MAIN_MODULE=1 ..."
)

# Side module (parquet extension)
add_library(duckdb_parquet SHARED ...)
set_target_properties(duckdb_parquet PROPERTIES
    LINK_FLAGS "-s SIDE_MODULE=1 ..."
)
```

**Runtime Loading:**

```javascript
// Load main module
const mainModule = await loadWasmModule('duckdb_core.wasm');

// Dynamically load side module
const sideModule = await loadWasmModule('duckdb_parquet.wasm');
mainModule.dlopen(sideModule);
```

**Problems with This Approach:**

1. **Shared Memory Requirement**: Dynamic linking in Emscripten requires `SharedArrayBuffer`, which needs COOP/COEP headers
2. **Cloudflare Workers Support**: Workers support SAB but with restrictions
3. **Global State**: DuckDB uses global state that's hard to partition
4. **Function Pointer Tables**: Must be coordinated across modules
5. **Asyncify Complexity**: Asyncify instrumentation must span all modules

### Approach 3B: Process Isolation with Durable Objects

Instead of WASM-level splitting, use Durable Objects as separate "processes" that each run a specialized DuckDB function:

```
┌─────────────────────────────────────────────────────────────────────┐
│                       Coordinator DO                                 │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │                    Query Orchestration                         │ │
│  │  • Parse SQL          • Plan execution                         │ │
│  │  • Distribute tasks   • Collect results                        │ │
│  └────────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────┬─────────────────────────────────┘
                                    │ Service Bindings
        ┌───────────────────────────┼───────────────────────┐
        ▼                           ▼                       ▼
┌───────────────┐           ┌───────────────┐       ┌───────────────┐
│ Scanner DO    │           │ Aggregator DO │       │ Parquet DO    │
│ ┌───────────┐ │           │ ┌───────────┐ │       │ ┌───────────┐ │
│ │  SQLite   │ │           │ │  DuckDB   │ │       │ │  Parquet  │ │
│ │  (index)  │ │           │ │  (agg)    │ │       │ │  Reader   │ │
│ └───────────┘ │           │ └───────────┘ │       │ └───────────┘ │
└───────────────┘           └───────────────┘       └───────────────┘
        │                           │                       │
        └───────────────────────────┼───────────────────────┘
                                    ▼
                            ┌───────────────┐
                            │      R2       │
                            │   (Parquet    │
                            │    files)     │
                            └───────────────┘
```

**Pros:**
- Each DO can be specialized and smaller
- True process isolation
- Can scale components independently
- SQLite-based DO could handle indexing/catalog
- Parquet DO could stream-read from R2

**Cons:**
- High coordination overhead
- Network latency between DOs
- Not really "DuckDB" anymore - more of a distributed system
- Data serialization costs between DOs

### Approach 3C: WASM Component Model (Future)

The emerging WASM Component Model (formerly "interface types") could eventually enable true module composition:

```wit
// duckdb-core.wit
interface query-engine {
    parse: func(sql: string) -> result<ast, error>;
    plan: func(ast: ast) -> result<plan, error>;
}

// duckdb-parquet.wit
interface parquet-reader {
    open: func(path: string) -> result<handle, error>;
    read-batch: func(handle: handle) -> result<record-batch, error>;
}
```

**Status:** Not yet ready for production. Cloudflare has prototype support but it's experimental.

---

## 4. Cross-Worker Module Communication

### Challenge

If we split DuckDB across workers, how do they communicate efficiently?

### Option 4A: Service Bindings (RPC-Style)

```typescript
// Executor worker
export default {
  async fetch(request: Request, env: Env) {
    const { plan } = await request.json();

    // Call storage worker for data
    const scanResult = await env.STORAGE_WORKER.fetch('http://storage/scan', {
      method: 'POST',
      body: JSON.stringify({ tableName: plan.table })
    });

    // Process locally
    const data = await scanResult.json();
    return Response.json(this.execute(plan, data));
  }
};
```

**Latency:** ~1-5ms per call (same colo), data transfer adds more.

### Option 4B: Durable Object WebSockets

For streaming data between components:

```typescript
// Parquet reader DO with WebSocket
export class ParquetReaderDO extends DurableObject {
  async fetch(request: Request) {
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader === 'websocket') {
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);

      // Stream parquet row groups
      this.streamParquet(server, request.url);

      return new Response(null, { status: 101, webSocket: client });
    }
  }

  async streamParquet(ws: WebSocket, url: string) {
    const parquetFile = await this.openParquet(url);
    for await (const rowGroup of parquetFile.rowGroups()) {
      ws.send(rowGroup.toArrowBuffer());
    }
    ws.close();
  }
}
```

### Option 4C: Shared R2 Data Exchange

Workers write intermediate results to R2, others read:

```
Worker A                     R2                      Worker B
    │                        │                          │
    │  PUT /temp/result-1    │                          │
    ├───────────────────────>│                          │
    │                        │                          │
    │  notify(Worker B)      │                          │
    ├─────────────────────────────────────────────────>│
    │                        │                          │
    │                        │<─────────────────────────┤
    │                        │  GET /temp/result-1      │
    │                        │                          │
```

**Latency:** Higher (R2 operations), but scales to large data.

### Option 4D: Queue-Based Pipeline

Use Cloudflare Queues for async data flow:

```typescript
// Producer
await env.DATA_QUEUE.send({
  type: 'scan_result',
  partitionId: 1,
  data: encodedData
});

// Consumer
export default {
  async queue(batch: MessageBatch<Message>, env: Env) {
    for (const message of batch.messages) {
      await this.processPartition(message.body);
      message.ack();
    }
  }
};
```

---

## 5. Cold Start Implications

### Current Cold Start Analysis

| Phase | Duration | Cause |
|-------|----------|-------|
| Worker startup | ~50ms | V8 isolate creation |
| WASM fetch | ~100-500ms | R2/KV retrieval |
| WASM compile | ~500-2000ms | 83MB module compilation |
| WASM instantiate | ~200-500ms | Memory allocation, imports |
| DuckDB init | ~100-300ms | Internal setup |
| **Total** | **1-4 seconds** | Mostly WASM compilation |

### Strategies to Reduce Cold Start

#### Strategy 5A: Pre-compiled WASM Modules

Cloudflare's `wasm` binding pre-compiles WASM at deployment:

```toml
# wrangler.toml
[[wasm_modules]]
name = "DUCKDB_WASM"
path = "./duckdb-asyncify.wasm"
```

```typescript
import DUCKDB_WASM from './duckdb-asyncify.wasm';

// Module is already compiled - just instantiate
const instance = await WebAssembly.instantiate(DUCKDB_WASM, imports);
```

**Impact:** Eliminates compile time (~1-2s improvement).

#### Strategy 5B: Snapshot-Based Warm Pools

Cloudflare announced "Warm Workers" - keeping isolates alive:

```
Cold Start: 2-4 seconds
Warm Start: 50-200ms
```

Combined with pre-compiled WASM, warm workers could achieve sub-second startup.

#### Strategy 5C: Lazy Module Initialization

Don't initialize DuckDB until first query:

```typescript
let db: DuckDB | null = null;

export default {
  async fetch(request: Request) {
    // Fast path for health checks
    if (request.url.endsWith('/health')) {
      return new Response('OK');
    }

    // Lazy init on actual queries
    if (!db) {
      db = await initDuckDB();
    }

    return db.query(request);
  }
};
```

#### Strategy 5D: Module Size Reduction

| Optimization | Est. Savings | Trade-off |
|--------------|--------------|-----------|
| Disable JSON extension | ~5MB | No JSON functions |
| Disable Parquet | ~15MB | External Parquet only |
| Strip debug symbols | ~10MB | Harder debugging |
| LTO optimization | ~5MB | Longer build time |
| Asyncify removal | ~40MB | No async I/O (sync only) |

**Achievable:** ~33MB (non-asyncify) vs 83MB (asyncify)

The asyncify overhead is substantial because it instruments every function for stack unwinding/rewinding.

---

## 6. Creative / Divergent Ideas

### Idea 6A: "Query Fragment" Workers

Instead of running full queries, workers execute query fragments:

```
┌──────────────────────────────────────────────────────────────────────┐
│                      Query: SELECT * FROM t1 JOIN t2                 │
└───────────────────────────────────┬──────────────────────────────────┘
                                    │
              ┌─────────────────────┼─────────────────────┐
              ▼                     ▼                     ▼
      ┌───────────────┐     ┌───────────────┐     ┌───────────────┐
      │ Fragment: Scan│     │ Fragment: Scan│     │ Fragment:     │
      │ Table t1      │     │ Table t2      │     │ Hash Join     │
      │ Worker A      │     │ Worker B      │     │ Worker C      │
      └───────┬───────┘     └───────┬───────┘     └───────┬───────┘
              │                     │                     │
              └──────────────┬──────┘                     │
                             ▼                            │
                     Arrow IPC over                       │
                     Service Binding                      │
                             │                            │
                             └────────────────────────────┘
```

Each worker only needs the WASM for its specific operation, potentially much smaller.

### Idea 6B: "SQL-to-TypeScript" Transpilation

For simple queries, transpile SQL to TypeScript that runs without WASM:

```sql
SELECT name, SUM(amount) FROM orders WHERE status = 'active' GROUP BY name
```

Becomes:

```typescript
const result = orders
  .filter(row => row.status === 'active')
  .reduce((acc, row) => {
    acc[row.name] = (acc[row.name] || 0) + row.amount;
    return acc;
  }, {});
```

**When useful:** Simple queries on small datasets. Native V8 array methods are fast.

### Idea 6C: Hybrid SQLite + DuckDB

Use SQLite (via D1 or DO's built-in SQLite) for:
- Metadata queries
- Simple lookups
- Transactional writes

Use DuckDB (via Sandbox VM) for:
- Analytical queries
- Large scans
- Complex aggregations

```typescript
export default {
  async fetch(request: Request, env: Env) {
    const { sql, params } = await request.json();

    const complexity = analyzeQueryComplexity(sql);

    if (complexity < THRESHOLD) {
      // Simple query - use D1 (SQLite)
      return env.D1_DB.prepare(sql).bind(...params).all();
    } else {
      // Complex query - forward to DuckDB Sandbox
      return env.DUCKDB_SANDBOX.fetch(request);
    }
  }
};
```

### Idea 6D: Parquet-Native Querying Without DuckDB

For read-only analytics on Parquet files in R2, we could build a minimal Parquet query engine:

```typescript
import { ParquetReader } from '@anthropic-pocs/iceberg-parquet';

async function queryParquet(sql: string, r2: R2Bucket) {
  const plan = parseSimpleSQL(sql); // Subset of SQL
  const file = await r2.get(plan.table);
  const reader = await ParquetReader.fromStream(file.body);

  return reader
    .project(plan.columns)
    .filter(plan.predicates)
    .aggregate(plan.groupBy);
}
```

**Pros:** Much smaller than full DuckDB. Could be <5MB WASM.
**Cons:** Limited SQL support. Reinventing the wheel.

### Idea 6E: "DuckDB as Remote Procedure"

Run DuckDB in a Sandbox VM and expose it as a service:

```typescript
// duckdb-rpc.ts
export default {
  async fetch(request: Request, env: Env) {
    const socket = await env.DUCKDB_SANDBOX.connect();
    const { sql, params } = await request.json();

    socket.write(msgpack.encode({ type: 'query', sql, params }));
    const result = await socket.read();

    return Response.json(msgpack.decode(result));
  }
};
```

This puts DuckDB where it belongs (full Linux environment with 12GB RAM) and Workers just route requests.

### Idea 6F: Time-Sliced Query Execution

Break long queries into time-bounded chunks:

```typescript
class TimeSlicedExecutor {
  private checkpoint: QueryCheckpoint | null = null;

  async execute(query: string, timeLimit = 5000) {
    const startTime = Date.now();

    // Resume from checkpoint if available
    if (this.checkpoint) {
      this.db.restoreCheckpoint(this.checkpoint);
    }

    while (Date.now() - startTime < timeLimit) {
      const batch = await this.db.fetchNextBatch();
      if (!batch) break; // Query complete

      yield batch;
    }

    // Save checkpoint for continuation
    this.checkpoint = this.db.createCheckpoint();
  }
}
```

Works with Durable Objects' persistent state.

---

## 7. Recommended Approach

Based on this analysis, here's a pragmatic path forward:

### Short Term (Now)

1. **Use standard (non-asyncify) DuckDB-WASM (~33MB)**
   - Sync XHR works in standard Workers (not edge-optimized)
   - Leaves ~95MB for runtime and data
   - Good for small datasets

2. **Pre-compile WASM at deployment**
   - Use wrangler's wasm binding
   - Eliminates cold-start compile time

3. **Implement loader worker pattern**
   - Store WASM versions in R2
   - Easy A/B testing and rollback

### Medium Term (1-3 months)

4. **Evaluate DuckDB loadable extensions**
   - Track `DUCKDB_WASM_LOADABLE_EXTENSIONS` development
   - Could enable parquet/json lazy loading

5. **Build Parquet-only query engine**
   - For R2-based analytics
   - Much smaller than full DuckDB
   - Integrates with iceberg-parquet package

### Long Term (3-6 months)

6. **Contribute to DuckDB-WASM modularization**
   - Work with DuckDB team on module splitting
   - Share Cloudflare Workers constraints

7. **Monitor WASM Component Model**
   - True module composition when available
   - Cloudflare is investing in this

8. **Hybrid architecture**
   - Simple queries: D1/SQLite
   - Medium queries: Workers WASM
   - Complex analytics: Sandbox VMs

---

## 8. Appendix: Size Analysis

### DuckDB-WASM Build Variants

| Variant | WASM Size | JS Size | Notes |
|---------|-----------|---------|-------|
| mvp | ~33MB | ~400KB | Minimal features |
| eh (exceptions) | ~35MB | ~400KB | WASM exceptions |
| coi (threads) | ~40MB | ~500KB | SharedArrayBuffer |
| asyncify | ~83MB | ~450KB | Async I/O support |
| relsize-asyncify | ~70MB | ~400KB | Size-optimized asyncify |

### Memory Budget Analysis (128MB limit)

| Component | Size | Notes |
|-----------|------|-------|
| V8 isolate overhead | ~5MB | Cloudflare platform |
| WASM module (asyncify) | ~83MB | Current build |
| WASM linear memory | ~16MB | Initial heap |
| JS runtime + globals | ~5MB | TypeScript bindings |
| Query working memory | ~19MB | **Available for data** |

With non-asyncify build:
| Component | Size | Notes |
|-----------|------|-------|
| V8 isolate overhead | ~5MB | |
| WASM module (mvp) | ~33MB | |
| WASM linear memory | ~16MB | |
| JS runtime | ~5MB | |
| Query working memory | ~69MB | **Much more headroom** |

---

## 9. References

### DuckDB-WASM Fork Files

- `/Users/nathanclevenger/projects/pocs/packages/duckdb-wasm-fork/lib/CMakeLists.txt`
- `/Users/nathanclevenger/projects/pocs/packages/duckdb-wasm-fork/scripts/wasm_build_lib.sh`
- `/Users/nathanclevenger/projects/pocs/packages/duckdb-wasm-fork/ASYNCIFY_IMPLEMENTATION_PLAN.md`
- `/Users/nathanclevenger/projects/pocs/packages/duckdb-wasm-fork/SPIKE4_PREGENERATE_CALLBACK_STUBS.md`

### Related Research

- `/Users/nathanclevenger/projects/pocs/database-engines/README.md`
- DuckDB Sandbox approach: `@dotdo/duckdb` package

### External Resources

- [Emscripten Dynamic Linking](https://emscripten.org/docs/compiling/Dynamic-Linking.html)
- [WASM Component Model](https://component-model.bytecodealliance.org/)
- [Cloudflare Workers Memory Limits](https://developers.cloudflare.com/workers/platform/limits/)

---

*Document generated 2026-01-16*
