/**
 * Test Worker that imports WASM files as static assets
 *
 * Cloudflare Workers blocks `new WebAssembly.Module(bytes)` from code,
 * but ALLOWS importing .wasm files as static modules.
 *
 * This test verifies that pre-compiled .wasm files can be used.
 *
 * Run with: wrangler dev lib/callback-stubs/test-worker-imports.ts
 */

// Import WASM modules as static assets
// Cloudflare Workers allows this because the WASM is compiled at deploy time
import stub_v from './wasm/v.wasm';
import stub_vi from './wasm/vi.wasm';
import stub_vii from './wasm/vii.wasm';
import stub_viii from './wasm/viii.wasm';
import stub_viiii from './wasm/viiii.wasm';
import stub_i from './wasm/i.wasm';
import stub_ii from './wasm/ii.wasm';
import stub_iii from './wasm/iii.wasm';
import stub_iiii from './wasm/iiii.wasm';
import stub_iiiii from './wasm/iiiii.wasm';
import stub_di from './wasm/di.wasm';
import stub_dii from './wasm/dii.wasm';
import stub_id from './wasm/id.wasm';
import stub_iid from './wasm/iid.wasm';
import stub_fi from './wasm/fi.wasm';
import stub_if from './wasm/if.wasm';

// Map of signature to pre-compiled WASM module
const STUB_MODULES: Record<string, WebAssembly.Module> = {
  'v': stub_v,
  'vi': stub_vi,
  'vii': stub_vii,
  'viii': stub_viii,
  'viiii': stub_viiii,
  'i': stub_i,
  'ii': stub_ii,
  'iii': stub_iii,
  'iiii': stub_iiii,
  'iiiii': stub_iiiii,
  'di': stub_di,
  'dii': stub_dii,
  'id': stub_id,
  'iid': stub_iid,
  'fi': stub_fi,
  'if': stub_if,
};

/**
 * Convert a JavaScript function to a WASM-compatible function
 * using pre-imported WASM modules.
 *
 * This works in Cloudflare Workers because the WASM modules are
 * imported as static assets and compiled at deploy time.
 */
function convertJsFunctionToWasm(func: Function, sig: string): Function {
  const module = STUB_MODULES[sig];
  if (!module) {
    throw new Error(`No pre-compiled stub for signature: ${sig}`);
  }

  const instance = new WebAssembly.Instance(module, { e: { f: func } });
  return instance.exports.f as Function;
}

interface Env {}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const results: Record<string, any> = {
      tests: [],
      summary: {
        passed: 0,
        failed: 0,
      },
    };

    // Test 1: Check that modules are imported
    const modulesImported = Object.keys(STUB_MODULES).length === 16;
    results.tests.push({
      name: 'WASM modules imported as static assets',
      passed: modulesImported,
      moduleCount: Object.keys(STUB_MODULES).length,
    });
    if (modulesImported) results.summary.passed++;
    else results.summary.failed++;

    // Test 2: Check module type
    const moduleType = typeof STUB_MODULES['iii'];
    const isWebAssemblyModule = STUB_MODULES['iii'] instanceof WebAssembly.Module;
    results.tests.push({
      name: 'Imported module is WebAssembly.Module',
      passed: isWebAssemblyModule,
      type: moduleType,
      isModule: isWebAssemblyModule,
    });
    if (isWebAssemblyModule) results.summary.passed++;
    else results.summary.failed++;

    // Test 3: Can we instantiate imported module with JS function?
    let instantiated = false;
    let instantiateError = null;
    let wasmFunc: Function | null = null;
    try {
      const jsFunc = (a: number, b: number) => a + b;
      const instance = new WebAssembly.Instance(STUB_MODULES['iii'], { e: { f: jsFunc } });
      wasmFunc = instance.exports.f as Function;
      instantiated = true;
    } catch (e: any) {
      instantiateError = e.message;
    }
    results.tests.push({
      name: 'Instantiate imported module with JS function',
      passed: instantiated,
      error: instantiateError,
    });
    if (instantiated) results.summary.passed++;
    else results.summary.failed++;

    // Test 4: Call the WASM-wrapped function
    let callResult = null;
    let callError = null;
    let callPassed = false;
    if (wasmFunc) {
      try {
        callResult = wasmFunc(2, 3);
        callPassed = callResult === 5;
      } catch (e: any) {
        callError = e.message;
      }
    }
    results.tests.push({
      name: 'Call WASM-wrapped function (2 + 3 = 5)',
      passed: callPassed,
      result: callResult,
      expected: 5,
      error: callError,
    });
    if (callPassed) results.summary.passed++;
    else results.summary.failed++;

    // Test 5: Use convertJsFunctionToWasm helper
    let convertPassed = false;
    let convertError = null;
    let convertResult = null;
    try {
      const jsFunc = (ptr: number, len: number) => ptr + len;
      const wasmWrapped = convertJsFunctionToWasm(jsFunc, 'iii');
      convertResult = (wasmWrapped as any)(10, 20);
      convertPassed = convertResult === 30;
    } catch (e: any) {
      convertError = e.message;
    }
    results.tests.push({
      name: 'convertJsFunctionToWasm (10 + 20 = 30)',
      passed: convertPassed,
      result: convertResult,
      expected: 30,
      error: convertError,
    });
    if (convertPassed) results.summary.passed++;
    else results.summary.failed++;

    // Test 6: Test PGlite-style read callback (iii signature)
    let pgliteReadPassed = false;
    let pgliteReadError = null;
    let pgliteReadResult = null;
    try {
      // Simulate PGlite's read callback
      // In real PGlite: (ptr: number, max_length: number) => bytes_read
      const readCallback = (ptr: number, maxLen: number) => {
        // Simulate reading 10 bytes
        return Math.min(10, maxLen);
      };
      const wasmRead = convertJsFunctionToWasm(readCallback, 'iii');
      pgliteReadResult = (wasmRead as any)(12345, 100);  // ptr=12345, maxLen=100
      pgliteReadPassed = pgliteReadResult === 10;
    } catch (e: any) {
      pgliteReadError = e.message;
    }
    results.tests.push({
      name: 'PGlite-style read callback (iii)',
      passed: pgliteReadPassed,
      result: pgliteReadResult,
      expected: 10,
      error: pgliteReadError,
    });
    if (pgliteReadPassed) results.summary.passed++;
    else results.summary.failed++;

    // Test 7: Test PGlite-style write callback (iii signature)
    let pgliteWritePassed = false;
    let pgliteWriteError = null;
    let pgliteWriteResult = null;
    try {
      // Simulate PGlite's write callback
      // In real PGlite: (ptr: number, length: number) => bytes_written
      const writeCallback = (ptr: number, len: number) => {
        // Simulate writing all bytes
        return len;
      };
      const wasmWrite = convertJsFunctionToWasm(writeCallback, 'iii');
      pgliteWriteResult = (wasmWrite as any)(54321, 50);  // ptr=54321, len=50
      pgliteWritePassed = pgliteWriteResult === 50;
    } catch (e: any) {
      pgliteWriteError = e.message;
    }
    results.tests.push({
      name: 'PGlite-style write callback (iii)',
      passed: pgliteWritePassed,
      result: pgliteWriteResult,
      expected: 50,
      error: pgliteWriteError,
    });
    if (pgliteWritePassed) results.summary.passed++;
    else results.summary.failed++;

    // Test 8: Test all signatures
    const sigTests: Record<string, { passed: boolean; error?: string }> = {};
    for (const sig of Object.keys(STUB_MODULES)) {
      try {
        // Create appropriate dummy function
        const dummyFunc = (...args: any[]) => {
          if (sig[0] === 'v') return;
          if (sig[0] === 'i') return 42;
          if (sig[0] === 'f') return 3.14;
          if (sig[0] === 'd') return 3.14159;
          return 0;
        };

        const wasmFunc = convertJsFunctionToWasm(dummyFunc, sig);

        // Call with appropriate number of args
        const argCount = sig.length - 1;
        const args = Array(argCount).fill(0);
        (wasmFunc as any)(...args);

        sigTests[sig] = { passed: true };
        results.summary.passed++;
      } catch (e: any) {
        sigTests[sig] = { passed: false, error: e.message };
        results.summary.failed++;
      }
    }
    results.tests.push({
      name: 'All signature stubs work',
      signatures: sigTests,
    });

    // Overall success
    results.success = results.summary.failed === 0;
    results.message = results.success
      ? 'All tests passed! Pre-compiled WASM stubs work in Cloudflare Workers.'
      : 'Some tests failed. See individual test results for details.';

    return new Response(JSON.stringify(results, null, 2), {
      headers: {
        'Content-Type': 'application/json',
      },
    });
  },
};
