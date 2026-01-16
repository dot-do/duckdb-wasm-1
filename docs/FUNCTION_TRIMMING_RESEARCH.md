# DuckDB Function Trimming Research

## Overview

This document analyzes the DuckDB core_functions extension to identify opportunities for size reduction in WASM builds. The current build (with `SMALLER_BINARY=1`) produces a 36.18 MB WASM file (down from 82.93 MB).

## Current Build Size Analysis

### Static Library Sizes (Compiled for WASM)

| Library | Size | Notes |
|---------|------|-------|
| `libduckdb_static.a` | 51 MB | Core DuckDB engine |
| `libcore_functions_extension.a` | **6.5 MB** | **Target for trimming** |
| `libparquet_extension.a` | 5.9 MB | Required for Parquet support |
| `libjson_extension.a` | 2.8 MB | Required for JSON support |
| `libarrow.a` | 24 MB | Arrow library (separate concern) |

### Core Functions Extension Breakdown

Object file sizes by category (compiled, not compressed):

| Category | Size | Priority |
|----------|------|----------|
| `scalar/date` | **1.3 MB** | PARTIAL KEEP - timestamps needed |
| `aggregate/holistic` | **1.1 MB** | TRIM - advanced quantiles |
| `scalar/string` | **708 KB** | PARTIAL KEEP - basic strings |
| `aggregate/distributive` | **658 KB** | PARTIAL KEEP - sum/avg/count |
| `scalar/math` | **520 KB** | PARTIAL KEEP - basic math |
| `scalar/list` | **444 KB** | TRIM - complex list ops |
| `scalar/operators` | **259 KB** | KEEP - basic operators |
| `aggregate/algebraic` | **183 KB** | PARTIAL KEEP - variance/stddev |
| `scalar/generic` | **171 KB** | KEEP - typeof, cast |
| `scalar/map` | **150 KB** | TRIM - map functions |
| `aggregate/nested` | **133 KB** | TRIM - histogram/list |
| `scalar/array` | **130 KB** | TRIM - array functions |
| `aggregate/regression` | **83 KB** | TRIM - regression stats |
| `scalar/struct` | **61 KB** | PARTIAL KEEP |
| `scalar/bit` | **59 KB** | KEEP - bit operations |
| `scalar/union` | **52 KB** | TRIM - union types |
| `scalar/random` | **42 KB** | KEEP - uuid generation |
| `scalar/blob` | **33 KB** | KEEP - blob encoding |
| `scalar/enum` | **32 KB** | TRIM - enum functions |
| `scalar/debug` | **12 KB** | TRIM - debug only |

**Total core_functions_extension: ~6.5 MB**

## Existing Build Flags

### SMALLER_BINARY Flag

Already enabled (`-DSMALLER_BINARY=1`). This flag:
- Removes specialized code paths for vector operations
- Uses runtime conditions instead of compile-time template specializations
- Reduces binary size at the cost of some performance

### DISABLE_CORE_FUNCTIONS Flag

Can disable the entire core_functions extension:
```makefile
# In Makefile
DISABLE_CORE_FUNCTIONS=1  # Adds core_functions to SKIP_EXTENSIONS
```

**Impact:** Would remove ALL SQL functions - not suitable for analytics.

## Function Categories Analysis

### Essential Functions for Iceberg/Parquet Analytics

#### Aggregate Functions - KEEP (~300 KB estimated)
- `sum`, `avg`, `count`, `min`, `max`
- `stddev`, `variance`, `stddev_pop`, `var_pop`
- `count_if`, `bool_and`, `bool_or`

#### Aggregate Functions - TRIM (~1.5 MB estimated)
- Holistic quantiles: `quantile_cont`, `quantile_disc`, `median`, `mode`
- Approximate: `approx_quantile`, `approx_count_distinct`, `approx_top_k`
- Reservoir: `reservoir_quantile`
- Statistical: `mad`, `kurtosis`, `skewness`, `entropy`
- Regression: `regr_*` family (9 functions)
- String aggregation: `string_agg`, `listagg`
- Histograms: `histogram`, `histogram_exact`, `bitstring_agg`

#### Scalar Date Functions - PARTIAL KEEP (~600 KB estimated)
Keep:
- `year`, `month`, `day`, `hour`, `minute`, `second`
- `date_part`, `date_trunc`, `date_diff`
- `epoch`, `epoch_ms`, `make_timestamp`

Trim:
- Interval construction: `to_centuries`, `to_decades`, `to_millennia`
- Exotic extraction: `era`, `julian`, `weekofyear`
- Calendar helpers: `dayname`, `monthname`, `last_day`

#### Scalar String Functions - PARTIAL KEEP (~400 KB estimated)
Keep:
- `length`, `lower`, `upper`, `trim`, `ltrim`, `rtrim`
- `substr`, `position`, `replace`, `concat`
- `like`, `ilike` (built into parser)

Trim:
- Similarity: `levenshtein`, `damerau_levenshtein`, `hamming`, `jaccard`, `jaro_*`
- Formatting: `bar`, `printf`, `format`
- Path parsing: `parse_dirname`, `parse_path`, `parse_filename`
- URL encoding: `url_encode`, `url_decode`
- Grapheme: `left_grapheme`, `right_grapheme`

#### Scalar Math Functions - PARTIAL KEEP (~300 KB estimated)
Keep:
- Basic: `abs`, `round`, `floor`, `ceil`, `trunc`, `sign`
- Arithmetic: `pow`, `sqrt`, `log`, `ln`, `exp`

Trim:
- Trigonometric: `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`, `cot`
- Hyperbolic: `sinh`, `cosh`, `tanh`, `asinh`, `acosh`, `atanh`
- Advanced: `gamma`, `lgamma`, `gcd`, `lcm`, `factorial`
- Radians/degrees: `radians`, `degrees`

#### Functions to Completely Remove (~1 MB estimated)
- `scalar/list` (444 KB) - Lambda/list aggregates not needed
- `scalar/array` (130 KB) - Vector similarity functions not needed
- `scalar/map` (150 KB) - Map operations not needed
- `aggregate/nested` (133 KB) - Histograms, list aggregation
- `scalar/union` (52 KB) - Union type operations
- `scalar/enum` (32 KB) - Enum functions
- `scalar/debug` (12 KB) - Debug functions

## Estimated Savings

| Action | Estimated Savings |
|--------|-------------------|
| Remove holistic aggregates | ~1.1 MB |
| Remove regression functions | ~83 KB |
| Remove list/array/map functions | ~724 KB |
| Trim date functions (50%) | ~650 KB |
| Trim string functions (50%) | ~350 KB |
| Trim math functions (50%) | ~260 KB |
| Remove nested/union/enum/debug | ~229 KB |
| **Total Estimated** | **~3.4 MB** |

Post-trimming `libcore_functions_extension.a`: ~3.1 MB (from 6.5 MB)

**Projected WASM size reduction:** ~2-3 MB after compression

## Implementation Approaches

### Option 1: Custom Extension (Recommended)

Create a minimal `iceberg_core_functions` extension:
1. Fork `core_functions` directory
2. Remove unwanted function files from CMakeLists.txt
3. Modify `function_list.cpp` to only register needed functions
4. Build as separate extension

**Pros:** Clean separation, easy to maintain
**Cons:** Requires maintaining a fork

### Option 2: Preprocessor Guards

Add `#ifdef DUCKDB_MINIMAL_ANALYTICS` guards around function registrations:

```cpp
// In function_list.cpp
static const StaticFunctionDefinition core_functions[] = {
    // Always include
    DUCKDB_AGGREGATE_FUNCTION_SET(SumFun),
    DUCKDB_AGGREGATE_FUNCTION_SET(AvgFun),

#ifndef DUCKDB_MINIMAL_ANALYTICS
    // Only include in full builds
    DUCKDB_AGGREGATE_FUNCTION_SET(ApproxQuantileFun),
    DUCKDB_AGGREGATE_FUNCTION(ApproxCountDistinctFun),
#endif
    // ...
};
```

**Pros:** Single codebase, build-time configuration
**Cons:** Requires upstream changes or patch maintenance

### Option 3: Linker Section Garbage Collection

Rely on link-time optimization with `--gc-sections`:
1. Ensure `-ffunction-sections -fdata-sections` during compile
2. Use `-Wl,--gc-sections` during link
3. Only used functions get included

**Pros:** No source changes needed
**Cons:** Limited effectiveness with static function registration

## Functions to Keep (Minimal Iceberg Analytics Build)

### Aggregate Functions (17 functions)
```
sum, avg, count, min, max
stddev, stddev_pop, variance, var_pop
count_if, bool_and, bool_or
arg_min, arg_max, first, last, list
```

### Scalar Date Functions (20 functions)
```
year, month, day, hour, minute, second, millisecond, microsecond
date_part, date_trunc, date_diff, date_sub
epoch, epoch_ms, epoch_us
make_date, make_time, make_timestamp
now, get_current_timestamp
```

### Scalar String Functions (15 functions)
```
length, lower, upper, trim, ltrim, rtrim
substr, left, right, replace, reverse
position, instr
chr, ascii
```

### Scalar Math Functions (12 functions)
```
abs, round, floor, ceil, trunc
pow, sqrt, log, ln, log10, log2, exp
sign
```

### Scalar Generic/Other (10 functions)
```
typeof, coalesce, ifnull, nullif
greatest, least
cast, try_cast
hash
```

**Total: ~75 functions** (vs ~350+ in full build)

## Next Steps

1. **Phase 1:** Profile actual function usage in Iceberg queries
2. **Phase 2:** Create minimal function list cmake configuration
3. **Phase 3:** Implement Option 2 (preprocessor guards) as POC
4. **Phase 4:** Measure actual size reduction
5. **Phase 5:** Performance benchmark comparison

## References

- DuckDB source: `submodules/duckdb/extension/core_functions/`
- Build config: `lib/cmake/duckdb.cmake`
- Extension config: `extension_config_wasm.cmake`
