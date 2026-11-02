"""Preserve Loogle diagnostics and attribute a bounded broader query explicitly."""

from __future__ import annotations

import contextvars
import json
import ssl
import urllib.parse
import urllib.request

import certifi
import orjson
from pydantic import BaseModel, Field

from lean_lsp_mcp import config
from lean_lsp_mcp.models import LoogleResult, LoogleResults
from lean_lsp_mcp.tools import search


class LoogleAttempt(BaseModel):
    query: str
    backend: str = "remote"
    count: int | None = None
    header: str | None = None
    suggestions: list[str] = Field(default_factory=list)
    error: str | None = None


class ExplainedLoogleResults(LoogleResults):
    query: str
    matched_query: str | None = None
    backend: str
    attempts: list[LoogleAttempt]
    suggestions: list[str] = Field(default_factory=list)
    note: str | None = None


# asyncio.to_thread copies ContextVars; the request-local list carries diagnostics back.
_capture: contextvars.ContextVar[list[LoogleAttempt] | None] = contextvars.ContextVar("loogle_diagnostics", default=None)


def loogle_remote(query: str, num_results: int) -> list[LoogleResult] | str:
    attempt = LoogleAttempt(query=query)
    capture = _capture.get()
    if capture is not None:
        capture.append(attempt)
    try:
        headers = {"User-Agent": "lean-lsp-mcp/0.1"}
        if extra := config.loogle_headers_raw():
            headers.update(json.loads(extra))
        request = urllib.request.Request(f"{config.loogle_url()}/json?q={urllib.parse.quote(query)}", headers=headers)
        with urllib.request.urlopen(request, timeout=10, context=ssl.create_default_context(cafile=certifi.where())) as response:
            data = orjson.loads(response.read())
        attempt.count = data.get("count")
        attempt.header = data.get("header")
        attempt.suggestions = [value for value in (data.get("suggestions") or []) if isinstance(value, str)]
        if error := data.get("error"):
            attempt.error = f"loogle query error: {error}"
            return attempt.error
        return [LoogleResult(name=hit.get("name", ""), type=hit.get("type", ""), module=hit.get("module", ""))
                for hit in (data.get("hits") or [])[:num_results]]
    except Exception as error:
        attempt.error = f"loogle error: {error}"
        return attempt.error


def filters(query: str) -> list[str]:
    """Split only top-level commas, preserving quoted strings and Lean type patterns."""
    result = []
    start = depth = 0
    quote = ""
    escaped = False
    for i, char in enumerate(query):
        if quote:
            if escaped:
                escaped = False
            elif char == "\\" and quote == '"':
                escaped = True
            elif char == quote:
                quote = ""
        elif char == '"':
            quote = '"'
        elif char == "«":
            quote = "»"
        elif char in "([{⦃⟨":
            depth += 1
        elif char in ")]}⦄⟩":
            depth -= 1
        elif char == "," and depth == 0:
            result.append(query[start:i].strip())
            start = i + 1
    if quote or depth:
        return []
    result.append(query[start:].strip())
    return result if all(result) else []


def broader_queries(query: str, suggestions: list[str]) -> list[str]:
    parts = filters(query)
    if len(parts) < 2:
        return []
    result = []
    # Accept server suggestions only when they remove filters from the original query.
    for suggestion in suggestions:
        subset = filters(suggestion)
        if subset and len(subset) < len(parts) and all(part in parts for part in subset):
            result.append(", ".join(subset))
    non_names = [part for part in parts if not part.startswith('"')]
    if non_names and len(non_names) < len(parts):
        result.append(", ".join(non_names))
    result.extend(", ".join(parts[:i] + parts[i + 1:]) for i in range(len(parts)))
    return list(dict.fromkeys(value for value in result if value != query))[:3]


async def explained_loogle(ctx, query: str, num_results: int, broaden: bool = True) -> ExplainedLoogleResults:
    attempts: list[LoogleAttempt] = []
    token = _capture.set(attempts)
    try:
        result = await search.loogle(ctx, query, num_results)
        backend = "remote" if attempts else "local"
        if not attempts:
            attempts.append(LoogleAttempt(query=query, backend="local", count=len(result.items)))
        suggestions = broader_queries(query, attempts[0].suggestions)
        matched = query if result.items else None
        note = None
        if not result.items and broaden and suggestions:
            broader = suggestions[0]
            before = len(attempts)
            try:
                result = await search.loogle(ctx, broader, num_results)
                if len(attempts) == before:
                    attempts.append(LoogleAttempt(query=broader, backend="local", count=len(result.items)))
                if result.items:
                    matched = broader
                    note = "No exact-query hits. Returned items match the explicitly recorded broader query."
            except Exception as error:
                if len(attempts) == before:
                    attempts.append(LoogleAttempt(query=broader, backend=backend, error=str(error)))
                note = "No exact-query hits. The single broader-query attempt failed; see diagnostics and suggestions."
        backends = {attempt.backend for attempt in attempts}
        backend = next(iter(backends)) if len(backends) == 1 else "mixed"
        return ExplainedLoogleResults(items=result.items, query=query, matched_query=matched, backend=backend,
                                      attempts=attempts, suggestions=suggestions, note=note)
    finally:
        _capture.reset(token)
