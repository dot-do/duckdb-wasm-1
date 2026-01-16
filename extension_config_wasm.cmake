################################################################################
# DuckDB-Wasm extension base config
################################################################################
#

duckdb_extension_load(json DONT_LINK)
duckdb_extension_load(parquet DONT_LINK)
# Autocomplete extension disabled for Workers - provides REPL/shell completion not needed in Workers
# duckdb_extension_load(autocomplete DONT_LINK)

duckdb_extension_load(icu DONT_LINK)
# Benchmark extensions removed to reduce bundle size
# duckdb_extension_load(tpcds DONT_LINK)
# duckdb_extension_load(tpch DONT_LINK)

#duckdb_extension_load(httpfs DONT_LINK)
