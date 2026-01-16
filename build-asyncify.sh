#!/bin/bash
# Build DuckDB-WASM with ASYNCIFY support for Cloudflare Workers compatibility
#
# ASYNCIFY enables JavaScript Promises to be awaited from within WASM,
# which is required for async I/O operations in Workers environments.
#
# Usage:
#   ./build-asyncify.sh [build-type] [cores]
#
# Build types:
#   dev      - Development build with debug info (default)
#   relperf  - Release build optimized for performance
#   relsize  - Release build optimized for size
#   relsize-asyncify - Size-optimized asyncify build (recommended for production)
#   debug    - Debug build with assertions
#
# Cores:
#   Number of parallel build jobs (default: 4)
#   Lower values reduce memory usage during wasm-opt linking
#   If wasm-opt runs out of memory, try: ./build-asyncify.sh dev 2
#
# Environment variables:
#   DOCKER_MEMORY - Memory limit for Docker container (default: 16g)
#                   Increase if wasm-opt runs out of memory
#
# Prerequisites:
#   - Docker installed and running with sufficient memory (16GB+ recommended)
#   - Submodules initialized (git submodule update --init --recursive)
#
# Output:
#   build/<build-type>/asyncify/duckdb_wasm.wasm
#   build/<build-type>/asyncify/duckdb_wasm.js
#   packages/duckdb-wasm/src/bindings/duckdb-asyncify.wasm
#   packages/duckdb-wasm/src/bindings/duckdb-asyncify.js

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_TYPE="${1:-dev}"
BUILD_CORES="${2:-4}"
DOCKER_MEMORY="${DOCKER_MEMORY:-16g}"
DOCKER_IMAGE="duckdb-wasm-asyncify-builder"

# Determine the features argument based on build type
# relsize-asyncify is a special combined mode that uses WASM_MIN_SIZE + ASYNCIFY
if [ "${BUILD_TYPE}" = "relsize-asyncify" ]; then
    FEATURES="relsize-asyncify"
    # For combined modes, we use relperf as the MODE and the combined mode as FEATURES
    BUILD_MODE="relperf"
else
    FEATURES="asyncify"
    BUILD_MODE="${BUILD_TYPE}"
fi

echo "=============================================="
echo "DuckDB-WASM Asyncify Build"
echo "=============================================="
echo "Build type: ${BUILD_TYPE}"
echo "Build mode: ${BUILD_MODE}"
echo "Features: ${FEATURES}"
echo "Build cores: ${BUILD_CORES}"
echo "Docker memory: ${DOCKER_MEMORY}"
echo "Script directory: ${SCRIPT_DIR}"
echo ""
echo "NOTE: wasm-opt with ASYNCIFY requires significant memory."
echo "If the build fails with SIGKILL, try:"
echo "  1. Reduce cores: ./build-asyncify.sh ${BUILD_TYPE} 2"
echo "  2. Increase Docker memory in Docker Desktop settings"
echo ""

# Ensure submodules are initialized
if [ ! -f "${SCRIPT_DIR}/submodules/duckdb/CMakeLists.txt" ]; then
    echo "Initializing submodules..."
    cd "${SCRIPT_DIR}"
    git submodule update --init --recursive
fi

# Apply patches if not already applied
echo "Applying patches..."
cd "${SCRIPT_DIR}"
(find patches/duckdb/* -type f -name '*.patch' -print0 2>/dev/null | xargs -0 cat | patch -p1 --forward -d submodules/duckdb) 2>/dev/null || true
(find patches/arrow/* -type f -name '*.patch' -print0 2>/dev/null | xargs -0 cat | patch -p1 --forward -d submodules/arrow) 2>/dev/null || true
(find patches/rapidjson/* -type f -name '*.patch' -print0 2>/dev/null | xargs -0 cat | patch -p1 --forward -d submodules/rapidjson) 2>/dev/null || true

# Build Docker image if needed
echo ""
echo "Building Docker image for WASM compilation..."
docker build -t "${DOCKER_IMAGE}" -f "${SCRIPT_DIR}/Dockerfile.asyncify" "${SCRIPT_DIR}"

# Create cache directories
mkdir -p "${SCRIPT_DIR}/.ccache"
mkdir -p "${SCRIPT_DIR}/.emscripten_cache"
mkdir -p "${SCRIPT_DIR}/build/${BUILD_MODE}/${FEATURES}"

# Run the build inside Docker
echo ""
echo "Starting WASM build inside Docker container..."
echo "This may take 10-30 minutes depending on your system."
echo ""

docker run --rm \
    --memory="${DOCKER_MEMORY}" \
    -v "${SCRIPT_DIR}:/wd" \
    -v "${SCRIPT_DIR}/.ccache:/root/.ccache" \
    -v "${SCRIPT_DIR}/.emscripten_cache:/root/.emscripten_cache" \
    -e "CCACHE_BASEDIR=/wd/lib" \
    -e "CCACHE_DIR=/root/.ccache" \
    -e "EM_CACHE=/root/.emscripten_cache" \
    -e "BUILD_CORES=${BUILD_CORES}" \
    "${DOCKER_IMAGE}" \
    /wd/scripts/wasm_build_lib.sh "${BUILD_MODE}" "${FEATURES}"

# Check if build succeeded
WASM_FILE="${SCRIPT_DIR}/build/${BUILD_MODE}/${FEATURES}/duckdb_wasm.wasm"
if [ -f "${WASM_FILE}" ]; then
    WASM_SIZE=$(stat -f%z "${WASM_FILE}" 2>/dev/null || stat -c%s "${WASM_FILE}" 2>/dev/null)
    if [ "${WASM_SIZE}" -gt 0 ]; then
        echo ""
        echo "=============================================="
        echo "Build completed successfully!"
        echo "=============================================="
        echo "WASM file: ${WASM_FILE}"
        echo "Size: $(echo "scale=2; ${WASM_SIZE} / 1048576" | bc) MB"
        echo ""
        echo "Output files:"
        ls -la "${SCRIPT_DIR}/build/${BUILD_MODE}/${FEATURES}/"*.wasm "${SCRIPT_DIR}/build/${BUILD_MODE}/${FEATURES}/"*.js 2>/dev/null || true
        echo ""
        echo "Bindings copied to:"
        ls -la "${SCRIPT_DIR}/packages/duckdb-wasm/src/bindings/duckdb-asyncify."* 2>/dev/null || echo "Not found in bindings directory"
    else
        echo "ERROR: WASM file is empty (0 bytes)"
        echo "Check the build logs for errors."
        exit 1
    fi
else
    echo "ERROR: WASM file not found at ${WASM_FILE}"
    echo "Build may have failed. Check the logs above."
    exit 1
fi
