"""Dependency-aware source search for Theoria's pinned lean-lsp-mcp adapter."""

from __future__ import annotations

import re
import threading
from pathlib import Path

import orjson

from lean_lsp_mcp.file_utils import LeanPathPolicy, build_lean_path_policy
from lean_lsp_mcp.search_utils import (
    _StderrCapture,
    _close_ripgrep_process,
    _create_ripgrep_process,
    _local_search_sort_key,
    _wait_for_ripgrep,
)

KEYWORDS = "theorem|lemma|def|axiom|class|instance|structure|inductive|abbrev|opaque"
LEAD = r"^[ \t]*(?:@\[[^\]\n]*\][ \t]*)*(?:(?:public|protected|private|noncomputable|partial|unsafe|scoped|local)[ \t]+)*"
# Lean names include Unicode symbols, primes and quoted components containing spaces/dots.
PART = r"(?:«[^»\n]+»|[^\s.:=(){}\[\]⦃⦄⟨⟩,;«»]+)"
DECLARATION = re.compile(LEAD + rf"(?P<kind>{KEYWORDS})[ \t]+(?P<name>{PART}(?:\.{PART})*)", re.MULTILINE)
SCOPE = re.compile(LEAD + r"(namespace|section|mutual|end)\b([^\n]*)", re.MULTILINE)


def mask_comments_and_strings(source: str) -> str:
    """Keep positions/quoted identifiers, hiding nested comments and literal contents."""
    masked = list(source)
    i = 0
    while i < len(source):
        start = i
        if source[i] == "«":
            end = source.find("»", i + 1)
            i = len(source) if end < 0 else end + 1
            continue
        if source.startswith("--", i):
            end = source.find("\n", i)
            i = len(source) if end < 0 else end
        elif source.startswith("/-", i):
            depth = 1
            i += 2
            while i < len(source) and depth:
                if source.startswith("/-", i):
                    depth += 1
                    i += 2
                elif source.startswith("-/", i):
                    depth -= 1
                    i += 2
                else:
                    i += 1
        elif source[i] == '"':
            i += 1
            while i < len(source):
                if source[i] == "\\":
                    i += 2
                elif source[i] == '"':
                    i += 1
                    break
                else:
                    i += 1
        else:
            i += 1
            continue
        for at in range(start, min(i, len(source))):
            if masked[at] != "\n":
                masked[at] = " "
    return "".join(masked)


def declarations_by_line(path: Path) -> dict[int, tuple[str, str]]:
    """Read names in their namespace, without treating commented examples as declarations."""
    source = mask_comments_and_strings(path.read_text(encoding="utf-8"))
    events = [(m.start(), "decl", m) for m in DECLARATION.finditer(source)]
    events.extend((m.start(), "scope", m) for m in SCOPE.finditer(source))
    stack: list[str] = []
    result = {}
    for at, kind, match in sorted(events, key=lambda event: event[0]):
        namespace = stack[-1] if stack else ""
        if kind == "scope":
            command, name = match.group(1), match.group(2).strip()
            if command == "end":
                if stack:
                    stack.pop()
            elif command == "namespace":
                stack.append(name.removeprefix("_root_.") if name.startswith("_root_.") else f"{namespace}.{name}" if namespace else name)
            else:
                stack.append(namespace)
        else:
            name = match.group("name")
            qualified = name.removeprefix("_root_.") if name.startswith("_root_.") else f"{namespace}.{name}" if namespace else name
            result[source.count("\n", 0, at) + 1] = (qualified, match.group("kind"))
    return result


def last_component(query: str) -> str:
    quoted = False
    start = 0
    for i, char in enumerate(query):
        if char == "«":
            quoted = True
        elif char == "»":
            quoted = False
        elif char == "." and not quoted:
            start = i + 1
    return query[start:]


def local_source_search(query: str, limit: int = 32, project_root: Path | None = None,
                        path_policy: LeanPathPolicy | None = None) -> list[dict[str, str]]:
    policy = path_policy or build_lean_path_policy(project_root or Path.cwd())
    query = query.strip().removeprefix("_root_.")
    if not query:
        return []
    # Pass resolved roots explicitly. Do not follow arbitrary symlinks from these roots.
    roots = list(dict.fromkeys(str(allowed.root.resolve()) for allowed in policy.allowed_roots))
    pattern = LEAD + rf"(?:{KEYWORDS})[ \t]+[^\n]*{re.escape(last_component(query))}"
    command = ["rg", "--json", "--no-ignore", "--smart-case", "--hidden", "--color", "never",
               "--no-messages", "-g", "*.lean", "-g", "!**/.git/**", "-g", "!**/.lake/build/**",
               "--", pattern, *roots]
    process = _create_ripgrep_process(command, cwd=str(policy.project_root))
    stderr = _StderrCapture()
    thread = None
    if process.stderr is not None:
        thread = threading.Thread(target=stderr.drain, args=(process.stderr,), daemon=True)
        thread.start()
    matches = []
    seen = set()
    parsed = {}
    stopped = False
    try:
        for line in process.stdout or []:
            event = orjson.loads(line)
            if event.get("type") != "match":
                continue
            data = event["data"]
            path = Path(data["path"]["text"]).resolve()
            try:
                display = policy.display_path(path)
                if path not in parsed:
                    parsed[path] = declarations_by_line(path)
            except (OSError, UnicodeError, ValueError):
                continue
            declaration = parsed[path].get(data["line_number"])
            if declaration is None:
                continue
            name, kind = declaration
            if query.casefold() not in name.casefold():
                continue
            key = (name, kind, display)
            if key in seen:
                continue
            seen.add(key)
            matches.append({"name": name, "kind": kind, "file": display})
            if len(matches) >= min(max(limit * 32, limit), 2048):
                process.terminate()
                stopped = True
                break
        _wait_for_ripgrep(process, terminated_early=stopped)
    finally:
        _close_ripgrep_process(process, thread)
    if process.returncode not in (0, 1) and not stopped:
        raise RuntimeError(f"ripgrep exited with code {process.returncode}: {stderr.text()}")
    matches.sort(key=lambda match: _local_search_sort_key(match, query.casefold()))
    return matches[:limit]
