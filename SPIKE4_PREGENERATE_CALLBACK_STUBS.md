# SPIKE 4: Patch Emscripten to Pre-generate Callback Stubs

**Date**: 2026-01-15
**Status**: VERIFIED WORKING
**Project**: Native Iceberg TS Module for Cloudflare Workers

---

## Executive Summary

This spike investigates whether Emscripten's `addFunction` can be patched to use pre-generated WASM stubs instead of runtime compilation. After analyzing Emscripten's source code and **testing in actual Cloudflare Workers**, we've proven this approach **works**.

**Key Finding**: Pre-generated WASM callback stubs work in Cloudflare Workers when imported as static `.wasm` assets. All 16 common signatures tested successfully, including the `'iii'` signature used by PGlite's read/write callbacks.

### Test Results (2026-01-15)

```
All tests passed! Pre-compiled WASM stubs work in Cloudflare Workers.
- 16 signatures tested: v, vi, vii, viii, viiii, i, ii, iii, iiii, iiiii, di, dii, id, iid, fi, if
- PGlite read callback simulation: PASSED
- PGlite write callback simulation: PASSED
```

### Critical Discovery: Import vs Runtime

| Approach | Works in Workers? |
|----------|------------------|
| `new WebAssembly.Module(bytes)` from code | **NO** - Blocked |
| `import stub from './stub.wasm'` as static asset | **YES** - Works! |
| `WebAssembly.Function` constructor | **NO** - Not available |

The key insight is that Cloudflare Workers allows WASM modules that are **imported as static assets** during deployment, but blocks any runtime `WebAssembly.Module()` construction, even from hardcoded byte arrays.

---

## Table of Contents

1. [Background](#background)
2. [Emscripten addFunction Analysis](#emscripten-addfunction-analysis)
3. [The convertJsFunctionToWasm Function](#the-convertjsfunctiontowasm-function)
4. [Pre-generation Strategy](#pre-generation-strategy)
5. [Implementation Approaches](#implementation-approaches)
6. [Proof of Concept](#proof-of-concept)
7. [Risk Assessment](#risk-assessment)
8. [Recommendation](#recommendation)

---

## Background

### The Problem

Both PGlite and DuckDB-WASM use Emscripten's `addFunction` to register JavaScript callbacks that can be called from C/WASM code. This function dynamically generates WebAssembly at runtime, which Cloudflare Workers blocks:

```
Error: WebAssembly.Module(): Wasm code generation disallowed by embedder
```

### Files Analyzed

| Source | Location |
|--------|----------|
| Emscripten libaddfunction.js | https://github.com/emscripten-core/emscripten/blob/main/src/lib/libaddfunction.js |
| PGlite pglite.ts | pglite-fork/packages/pglite/src/pglite.ts |
| PGlite pglite-comm.h | pglite-fork/postgres-pglite/pglite/includes/pglite-comm.h |

---

## Emscripten addFunction Analysis

### Key Components

The `addFunction` implementation consists of several parts:

1. **wasmTypeCodes**: Maps signature characters to WASM type codes
2. **sigToWasmTypes**: Converts signature strings to WebAssembly.Type objects
3. **generateTypePack**: Encodes types using LEB128
4. **convertJsFunctionToWasm**: Creates the WASM wrapper module
5. **addFunction/removeFunction**: Manages the function table

### Type Code Mappings

```javascript
const wasmTypeCodes = {
  'i': 0x7f,  // i32
  'p': 0x7f,  // i32 (pointer - same as i32 in 32-bit WASM)
  'j': 0x7e,  // i64
  'f': 0x7d,  // f32
  'd': 0x7c,  // f64
  'e': 0x6f,  // externref
  'v': null   // void (only for return type)
};
```

### Signature Format

- First character = return type
- Subsequent characters = parameter types
- Example: `'iii'` = function returning i32 with two i32 parameters

---

## The convertJsFunctionToWasm Function

### Full Source Code (from Emscripten)

```javascript
$convertJsFunctionToWasm: (func, sig) => {
    // Modern approach: Use WebAssembly.Function if available
    if (WebAssembly.Function) {
      return new WebAssembly.Function(sigToWasmTypes(sig), func);
    }

    // Fallback: Generate minimal WASM module
    var bytes = Uint8Array.of(
      0x00, 0x61, 0x73, 0x6d, // magic ("\0asm")
      0x01, 0x00, 0x00, 0x00, // version: 1
      0x01, // Type section code
        ...uleb128EncodeWithLen([
          0x01, // count: 1
          0x60 /* form: func */,
          ...generateTypePack(sig.slice(1)),  // parameter types
          ...generateTypePack(sig[0] === 'v' ? '' : sig[0])  // return type
        ]),
      0x02, 0x07, // import section
        0x01, 0x01, 0x65, 0x01, 0x66, 0x00, 0x00,
      0x07, 0x05, // export section
        0x01, 0x01, 0x66, 0x00, 0x00,
    );

    var module = new WebAssembly.Module(bytes);  // <-- BLOCKED IN WORKERS!
    var instance = new WebAssembly.Instance(module, { 'e': { 'f': func } });
    return instance.exports['f'];
  }
```

### How It Works

1. Creates a minimal WASM module (~50 bytes)
2. Module imports a function from `{e: {f: jsFunc}}`
3. Module immediately re-exports that function
4. The exported function can be added to the WASM table

### WASM Module Structure

```
+------------------+
| Magic + Version  | 8 bytes: 0x00 0x61 0x73 0x6d 0x01 0x00 0x00 0x00
+------------------+
| Type Section     | Variable: function signature encoding
+------------------+
| Import Section   | 7 bytes: imports 'f' from module 'e'
+------------------+
| Export Section   | 5 bytes: exports 'f' with index 0
+------------------+
```

---

## Pre-generation Strategy

### Key Insight

The WASM module structure is **deterministic** based on the signature. For a given signature like `'iii'`, the byte sequence is always the same. This means we can:

1. **Pre-compute** the byte arrays for common signatures
2. **Ship** them as static data
3. **Use** `new WebAssembly.Module(precomputedBytes)` at startup (allowed)
4. **Instantiate** with the actual JS function at runtime (allowed)

### Why This Might Work

Cloudflare Workers blocks:
- `new WebAssembly.Module(dynamicallyGeneratedBytes)` - **Blocked**
- `new WebAssembly.compile(...)` from dynamic sources - **Blocked**

But allows:
- `new WebAssembly.Module(staticBytes)` imported from module - **Allowed**
- `WebAssembly.instantiate(preloadedModule, imports)` - **Allowed**

The key question: **Are the bytes themselves the problem, or is it the dynamic generation?**

### Testing Required

We need to verify:
1. Can we create `WebAssembly.Module` from static `Uint8Array` in Workers?
2. Does the module need to be imported as `.wasm` asset, or can inline bytes work?

---

## Implementation Approaches

### Approach 1: Pre-compiled Module Assets

Ship pre-compiled `.wasm` files for each signature:

```
/wasm-stubs/
  iii.wasm   (50 bytes)
  vi.wasm    (48 bytes)
  v.wasm     (45 bytes)
  iiii.wasm  (52 bytes)
  ...
```

**Workers Entry Point:**
```typescript
import stub_iii from './wasm-stubs/iii.wasm';
import stub_vi from './wasm-stubs/vi.wasm';
// ...

const stubModules = {
  'iii': stub_iii,
  'vi': stub_vi,
  // ...
};

function addFunction(jsFunc, sig) {
  const module = stubModules[sig];
  if (!module) throw new Error(`Unknown signature: ${sig}`);
  const instance = new WebAssembly.Instance(module, { e: { f: jsFunc } });
  return instance.exports.f;
}
```

**Pros:**
- WASM files are imported as static assets (definitely allowed)
- Clean separation of concerns
- Easy to add new signatures

**Cons:**
- Requires one file per signature
- Must know all signatures at build time
- Increases bundle size (slightly)

### Approach 2: Inline Binary Lookup Table

Ship a JavaScript lookup table with pre-computed bytes:

```typescript
const STUB_BYTES = {
  'iii': new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, ...]),
  'vi': new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, ...]),
  'v': new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, ...]),
  // ... more signatures
};

// Pre-compile modules at module load time (not at runtime)
const STUB_MODULES = Object.fromEntries(
  Object.entries(STUB_BYTES).map(([sig, bytes]) =>
    [sig, new WebAssembly.Module(bytes)]
  )
);

function addFunction(jsFunc, sig) {
  const module = STUB_MODULES[sig];
  if (!module) throw new Error(`Unknown signature: ${sig}`);
  const instance = new WebAssembly.Instance(module, { e: { f: jsFunc } });
  return instance.exports.f;
}
```

**Question:** Will `new WebAssembly.Module(staticBytes)` work at module load time?

**Pros:**
- Single file, no external assets
- Fast lookup

**Cons:**
- Might still be blocked (needs testing)
- Must know signatures at build time

### Approach 3: Build-time Module Embedding

Generate the modules during the Emscripten build and embed them in the main WASM:

```bash
# During emcc build
emcc ... -sEMBEDDED_CALLBACK_STUBS=1 -sCALLBACK_SIGNATURES=iii,vi,v,iiii
```

The main WASM would include pre-compiled stub modules as data sections that can be extracted and used.

**Pros:**
- No runtime compilation at all
- Integrated with build process
- Guaranteed to match WASM ABI

**Cons:**
- Requires modifying Emscripten build
- More complex integration

### Approach 4: WebAssembly.Function Polyfill Check

Some environments may support `WebAssembly.Function` directly:

```typescript
function addFunction(jsFunc, sig) {
  // Try the modern API first
  if (typeof WebAssembly.Function === 'function') {
    return new WebAssembly.Function(sigToWasmTypes(sig), jsFunc);
  }

  // Fall back to pre-compiled stubs
  return addFunctionWithStub(jsFunc, sig);
}
```

**Question:** Does Cloudflare Workers support `WebAssembly.Function`?

---

## Proof of Concept

### Step 1: Generate Stub Bytes

```javascript
// generate-stubs.js (run in Node.js)
const signatures = ['v', 'vi', 'vii', 'viii', 'i', 'ii', 'iii', 'iiii'];

function generateStubBytes(sig) {
  const wasmTypeCodes = { 'i': 0x7f, 'v': null };

  function uleb128EncodeWithLen(arr) {
    const n = arr.length;
    return [(n % 128) | 128, n >> 7, ...arr];
  }

  function generateTypePack(types) {
    const codes = Array.from(types, t => wasmTypeCodes[t]).filter(c => c !== null);
    const n = codes.length;
    return [(n % 128) | 128, n >> 7, ...codes];
  }

  const paramTypes = sig.slice(1);
  const returnType = sig[0] === 'v' ? '' : sig[0];

  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, // magic
    0x01, 0x00, 0x00, 0x00, // version
    0x01, // type section
    ...uleb128EncodeWithLen([
      0x01, 0x60,
      ...generateTypePack(paramTypes),
      ...generateTypePack(returnType)
    ]),
    0x02, 0x07, 0x01, 0x01, 0x65, 0x01, 0x66, 0x00, 0x00, // import section
    0x07, 0x05, 0x01, 0x01, 0x66, 0x00, 0x00, // export section
  ]);
}

// Generate and output
for (const sig of signatures) {
  const bytes = generateStubBytes(sig);
  console.log(`'${sig}': new Uint8Array([${Array.from(bytes).join(', ')}]),`);
}
```

### Step 2: Test in Workers

```typescript
// test-worker.ts
const STUB_BYTES = {
  'iii': new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, ...]),
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      // Test 1: Can we create Module from static bytes?
      const bytes = STUB_BYTES['iii'];
      const module = new WebAssembly.Module(bytes);

      // Test 2: Can we instantiate with JS function?
      const jsFunc = (a: number, b: number) => a + b;
      const instance = new WebAssembly.Instance(module, { e: { f: jsFunc } });
      const wasmFunc = instance.exports.f as Function;

      // Test 3: Does it work?
      const result = wasmFunc(2, 3);

      return Response.json({
        success: true,
        moduleCreated: true,
        instanceCreated: true,
        result,
        expected: 5
      });
    } catch (e) {
      return Response.json({
        success: false,
        error: e.message,
        stack: e.stack
      });
    }
  }
};
```

---

## Pre-generated Stub Bytes for Common Signatures

Based on the Emscripten source code analysis, here are the pre-computed byte arrays:

### Signature: 'v' (void function, no params)
```javascript
new Uint8Array([
  0x00, 0x61, 0x73, 0x6d,  // magic
  0x01, 0x00, 0x00, 0x00,  // version
  0x01, 0x84, 0x80, 0x80, 0x80, 0x00,  // type section (length encoded)
  0x01, 0x60, 0x00, 0x00,  // func type: () -> void
  0x02, 0x07,              // import section
  0x01, 0x01, 0x65, 0x01, 0x66, 0x00, 0x00,
  0x07, 0x05,              // export section
  0x01, 0x01, 0x66, 0x00, 0x00
])
```

### Signature: 'vi' (void function, one i32 param)
```javascript
new Uint8Array([
  0x00, 0x61, 0x73, 0x6d,
  0x01, 0x00, 0x00, 0x00,
  0x01, 0x85, 0x80, 0x80, 0x80, 0x00,
  0x01, 0x60, 0x01, 0x7f, 0x00,  // func type: (i32) -> void
  0x02, 0x07,
  0x01, 0x01, 0x65, 0x01, 0x66, 0x00, 0x00,
  0x07, 0x05,
  0x01, 0x01, 0x66, 0x00, 0x00
])
```

### Signature: 'iii' (i32 function, two i32 params) - Used by PGlite
```javascript
new Uint8Array([
  0x00, 0x61, 0x73, 0x6d,
  0x01, 0x00, 0x00, 0x00,
  0x01, 0x87, 0x80, 0x80, 0x80, 0x00,
  0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,  // func type: (i32, i32) -> i32
  0x02, 0x07,
  0x01, 0x01, 0x65, 0x01, 0x66, 0x00, 0x00,
  0x07, 0x05,
  0x01, 0x01, 0x66, 0x00, 0x00
])
```

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Static WebAssembly.Module blocked | Medium | High | Test in actual Workers environment |
| Signature mismatch | Low | High | Generate exact same bytes as Emscripten |
| Missing signatures | Medium | Medium | Enumerate all used signatures |
| Performance overhead | Low | Low | Instance creation is fast |

### Key Unknowns

1. **Does Workers allow `new WebAssembly.Module(staticBytes)`?**
   - If YES: Both Approach 1 and 2 work
   - If NO: Only Approach 1 (imported .wasm assets) works

2. **Does Workers support `WebAssembly.Function`?**
   - If YES: No patching needed at all!
   - If NO: Proceed with stub approach

---

## Recommendation

### VERIFIED: Use Imported WASM Stub Assets

The testing confirms that **Approach 1 (imported .wasm assets)** works in Cloudflare Workers. Here's the implementation pattern:

```typescript
// Import pre-generated WASM stubs
import stub_iii from './wasm-stubs/iii.wasm';
import stub_vi from './wasm-stubs/vi.wasm';
// ... more signatures

const STUB_MODULES: Record<string, WebAssembly.Module> = {
  'iii': stub_iii,
  'vi': stub_vi,
  // ...
};

function convertJsFunctionToWasm(func: Function, sig: string): Function {
  const module = STUB_MODULES[sig];
  if (!module) throw new Error(`No stub for: ${sig}`);
  const instance = new WebAssembly.Instance(module, { e: { f: func } });
  return instance.exports.f as Function;
}
```

### What Was Tested

| Test | Result |
|------|--------|
| WebAssembly.Function available | NO |
| new WebAssembly.Module(staticBytes) | BLOCKED |
| Import .wasm as static asset | WORKS |
| Instantiate with JS function | WORKS |
| Call WASM-wrapped function | WORKS |
| PGlite read callback (iii) | WORKS |
| PGlite write callback (iii) | WORKS |
| All 16 signatures | ALL PASS |

### Next Steps for PGlite Integration

1. **Copy WASM stubs** to PGlite build output
2. **Patch pglite.ts** to import stubs instead of using `addFunction`
3. **Test with actual PGlite** initialization in Workers
4. **Profile** any performance differences

### Estimated Remaining Effort

| Task | Time |
|------|------|
| Integrate stubs with PGlite build | 2 hours |
| Patch pglite.ts | 2 hours |
| End-to-end testing | 4 hours |
| Documentation | 1 hour |
| **Total** | **~1 day** |

---

## Conclusion

**SUCCESS!** Patching Emscripten's `addFunction` to use pre-generated callback stubs **works in Cloudflare Workers**.

### Verified Results

- **WebAssembly.Function**: Not available in Workers
- **Runtime WebAssembly.Module**: Blocked (even with static bytes)
- **Imported .wasm assets**: **WORKS PERFECTLY**

### Implementation Delivered

This spike produced a working implementation:

1. **Generator script**: `scripts/generate-callback-stubs.js`
   - Creates WASM stub files for any signature
   - Verified all 16 common signatures

2. **Pre-compiled stubs**: `lib/callback-stubs/wasm/*.wasm`
   - 16 signature stubs (30-35 bytes each)
   - Matches Emscripten's output exactly

3. **TypeScript module**: `lib/callback-stubs/index.ts`
   - Drop-in replacement for `convertJsFunctionToWasm`
   - Includes inline byte arrays for reference

4. **Test workers**: `lib/callback-stubs/test-worker*.ts`
   - Verified functionality in actual Workers environment

### Impact

This solution enables PGlite and potentially DuckDB-WASM to work in Cloudflare Workers by replacing the blocked `addFunction` calls with pre-compiled WASM stub imports. The approach is **less invasive** than the alternatives (static callbacks, import-based callbacks) because it preserves the existing API contract.

---

## References

### Source Code
- [Emscripten libaddfunction.js](https://github.com/emscripten-core/emscripten/blob/main/src/lib/libaddfunction.js)
- [PGlite pglite.ts](../pglite-fork/packages/pglite/src/pglite.ts)
- [PGlite pglite-comm.h](../pglite-fork/postgres-pglite/pglite/includes/pglite-comm.h)

### Related Issues
- [Emscripten #17392 - More efficient convertJsFunctionToWasm](https://github.com/emscripten-core/emscripten/issues/17392)
- [Emscripten #7120 - JS functions in wasm tables](https://github.com/emscripten-core/emscripten/issues/7120)
- [Emscripten #6100 - addFunction for Wasm backend](https://github.com/emscripten-core/emscripten/issues/6100)

### Documentation
- [Emscripten Interacting with Code](https://emscripten.org/docs/porting/connecting_cpp_and_javascript/Interacting-with-code.html)

---

*Spike completed 2026-01-15*
