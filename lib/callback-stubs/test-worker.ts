/**
 * Test Worker to verify pre-compiled WASM stubs work in Cloudflare Workers
 *
 * This tests whether we can:
 * 1. Create WebAssembly.Module from static byte arrays
 * 2. Instantiate modules with JS function imports
 * 3. Use the exported functions
 *
 * Run with: wrangler dev lib/callback-stubs/test-worker.ts
 */

import { CALLBACK_STUB_BYTES, convertJsFunctionToWasm } from './index';

interface Env {
  // Add bindings here if needed
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const results: Record<string, any> = {
      tests: [],
      summary: {
        passed: 0,
        failed: 0,
      },
    };

    // Test 1: Check WebAssembly.Function availability
    const hasWasmFunction = typeof (WebAssembly as any).Function === 'function';
    results.tests.push({
      name: 'WebAssembly.Function available',
      passed: hasWasmFunction,
      value: hasWasmFunction,
    });
    if (hasWasmFunction) results.summary.passed++;
    else results.summary.failed++;

    // Test 2: Can we create WebAssembly.Module from static bytes?
    let moduleCreated = false;
    let moduleError = null;
    try {
      const bytes = CALLBACK_STUB_BYTES['iii'];
      new WebAssembly.Module(bytes);
      moduleCreated = true;
    } catch (e: any) {
      moduleError = e.message;
    }
    results.tests.push({
      name: 'Create WebAssembly.Module from static bytes',
      passed: moduleCreated,
      error: moduleError,
    });
    if (moduleCreated) results.summary.passed++;
    else results.summary.failed++;

    // Test 3: Can we instantiate with a JS function?
    let instantiated = false;
    let instantiateError = null;
    let wasmFunc: Function | null = null;
    try {
      const bytes = CALLBACK_STUB_BYTES['iii'];
      const module = new WebAssembly.Module(bytes);
      const jsFunc = (a: number, b: number) => a + b;
      const instance = new WebAssembly.Instance(module, { e: { f: jsFunc } });
      wasmFunc = instance.exports.f as Function;
      instantiated = true;
    } catch (e: any) {
      instantiateError = e.message;
    }
    results.tests.push({
      name: 'Instantiate module with JS function',
      passed: instantiated,
      error: instantiateError,
    });
    if (instantiated) results.summary.passed++;
    else results.summary.failed++;

    // Test 4: Can we call the WASM function?
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
      name: 'Call WASM-wrapped function (2 + 3)',
      passed: callPassed,
      result: callResult,
      expected: 5,
      error: callError,
    });
    if (callPassed) results.summary.passed++;
    else results.summary.failed++;

    // Test 5: Try the convertJsFunctionToWasm function
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
      name: 'convertJsFunctionToWasm (10 + 20)',
      passed: convertPassed,
      result: convertResult,
      expected: 30,
      error: convertError,
    });
    if (convertPassed) results.summary.passed++;
    else results.summary.failed++;

    // Test 6: Test all common signatures
    const sigTests: Record<string, { passed: boolean; error?: string }> = {};
    for (const sig of Object.keys(CALLBACK_STUB_BYTES)) {
      try {
        const bytes = CALLBACK_STUB_BYTES[sig];
        const module = new WebAssembly.Module(bytes);

        // Create appropriate dummy function
        const dummyFunc = (...args: any[]) => {
          if (sig[0] === 'v') return;
          if (sig[0] === 'i') return 42;
          if (sig[0] === 'f') return 3.14;
          if (sig[0] === 'd') return 3.14159;
          return 0;
        };

        const instance = new WebAssembly.Instance(module, { e: { f: dummyFunc } });
        const func = instance.exports.f as Function;

        // Call with appropriate number of args
        const argCount = sig.length - 1;
        const args = Array(argCount).fill(0);
        func(...args);

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

    // Return results
    return new Response(JSON.stringify(results, null, 2), {
      headers: {
        'Content-Type': 'application/json',
      },
    });
  },
};
