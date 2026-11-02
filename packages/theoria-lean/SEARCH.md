# Native-library theorem search

The Theoria launcher adapts the pinned `lean-lsp-mcp` package without modifying its installation.

## Local search

`lean_local_search` searches the active project, the explicitly resolved dependency roots allowed by
the MCP path policy, and the matching Lean standard library. This includes native packages reached
through `.lake/packages` symlinks. It does not follow arbitrary symlinks inside those roots.

Names can contain Unicode, primes and quoted components such as `Native.ι_probe` or
`Native.«a declaration»`. Matches retain their fully qualified names and project-relative paths.
Comments and string contents are excluded from declaration parsing.

The upstream LSP symbol-index pass is retained for generated declarations. `index: warming`,
`unavailable`, or `error` means an empty result is not a complete absence check. File-based LSP tools
start the language server; repeated identical searches do not force its index to finish.

## Loogle

Loogle still searches its backend's corpus: the public endpoint's Mathlib snapshot, or the configured
local/custom backend. Local source-search coverage does not add native packages to public Loogle.

The response keeps the original query and each attempt's `count`, diagnostic `header`, `suggestions`
and any error. After an empty result, Theoria may issue **one** broader query by removing filters.
`matched_query` identifies the query that produced returned items; broader matches are not represented
as exact-query matches. For example, an empty `"div_const", fderiv` query can broaden to `fderiv`.

Use `broaden: false` to request exact-query-only behavior. Both attempts use the upstream rate limiter,
local-backend selection and fallback path. A broader-query failure retains the original empty result
and its diagnostics. Independent requests keep their diagnostic records separate.

Search results are leads: check the candidate in the task's pinned Lean environment before using it.

## Verification

`test/search_server_test.py` tests the adapter through the real MCP SDK, using local fixture packages
and mocked HTTP responses. `test/lsp_server_test.py` additionally checks cold Unicode dependency
search and real Lean LSP tools in a sandbox. Both are included by:

```sh
node --test packages/theoria-lean/test/search.test.ts
```
