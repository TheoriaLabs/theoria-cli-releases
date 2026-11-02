"""Theoria defaults around pinned lean-lsp-mcp; the installed package stays unchanged."""

import os
from typing import Annotated, Literal

from mcp.server.mcpserver import Context
from mcp.types import ToolAnnotations
from pydantic import Field

from lean_lsp_mcp import main, server
from lean_lsp_mcp.models import LeanFinderResults, LocalSearchResults
from lean_lsp_mcp.tools import search
from local_search import local_source_search
from loogle_search import ExplainedLoogleResults, explained_loogle, loogle_remote

LOOGLE_SYNTAX = (
    'Separate filters with commas (AND), not spaces. Quote name substrings: '
    '\'"Matrix", "mul_comm"\' is valid; \'"Matrix" "mul_comm"\' is invalid. '
    'Keep known constants unquoted, e.g. Real.sin, "add". Quote guessed declaration '
    'names as substrings rather than unknown Lean identifiers. For natural language, use Lean Finder.'
)


def register_search_tools(mcp, top_k: int):
    if not isinstance(top_k, int) or isinstance(top_k, bool) or top_k < 1:
        raise ValueError("Theoria search top-k must be a positive integer")
    # Process-local adapter hooks; the installed upstream package is never modified.
    server.lean_local_search = local_source_search
    search.loogle_remote = loogle_remote

    async def loogle(
        ctx: Context,
        query: Annotated[str, Field(description=LOOGLE_SYNTAX)],
        num_results: Annotated[int, Field(description="Max results", ge=1)] = top_k,
        broaden: Annotated[bool, Field(description="After an empty query, try at most one broader query by removing filters; report it separately")] = True,
    ) -> ExplainedLoogleResults:
        return await explained_loogle(ctx, query, num_results, broaden)

    async def leanfinder(
        ctx: Context,
        query: Annotated[str, Field(description="Mathematical concept or proof state")],
        num_results: Annotated[int, Field(description="Max results", ge=1)] = top_k,
        version: Annotated[Literal["v4.19.0", "v4.24.0", "v4.28.0"], Field(description="Mathlib version index to search")] = "v4.28.0",
    ) -> LeanFinderResults:
        return await search.leanfinder(ctx, query, num_results, version)

    async def local_search(
        ctx: Context,
        query: Annotated[str, Field(description="Declaration name or prefix; supports Unicode and quoted Lean identifiers")],
        limit: Annotated[int, Field(description="Max matches", ge=1)] = 10,
        project_root: Annotated[str | None, Field(description="Project root (inferred if omitted)")] = None,
    ) -> LocalSearchResults:
        return await search.local_search(ctx, query, limit, project_root)

    for name, function, title, description in [
        ("lean_loogle", loogle, "Loogle", f"{search.loogle.__doc__}\n\n{LOOGLE_SYNTAX}"),
        ("lean_leanfinder", leanfinder, "Lean Finder", search.leanfinder.__doc__),
        ("lean_local_search", local_search, "Local Search", "Search declarations in this project, its allowed native dependencies and the Lean standard library, including Unicode names. An empty result with index=warming/unavailable/error has incomplete generated-declaration coverage."),
    ]:
        mcp.remove_tool(name)
        mcp.add_tool(function, name=name, description=description, annotations=ToolAnnotations(
            title=title, read_only_hint=True, idempotent_hint=True, open_world_hint=name != "lean_local_search"))


if __name__ == "__main__":
    register_search_tools(server.mcp, int(os.environ.get("THEORIA_SEARCH_TOP_K", "10")))
    raise SystemExit(main())
