---
description: Formalize a statement as a Lean 4 theorem (stated, not proved); Theoria checks it elaborates
argument-hint: <statement, or a file with one> [--name theorem_name]
max-attempts: 3
timeout-seconds: 300
---
Formalize a mathematical statement for Theoria, a verification-first research workspace. Theoria checks the result with Lean itself when you stop; your job is a faithful statement, not a proof.

## What to formalize

{{#if source_file}}The statement is in {{source_file}}{{#if request}}; focus on: {{request}}{{/if}}. Read it first.{{/if}}
{{#unless source_file}}{{request}}{{/unless}}

{{#if free}}This is a description, not a precise statement. Use the standard mathematical meaning of the name or phrase. If it has more than one standard reading (for example a weak and a strong form), do not choose: state each reading as its own theorem, and Theoria will ask the user which they mean.{{/if}}

## What to write

Write {{file}} containing:

- `import Mathlib` (and anything else it needs), then one theorem named `{{theorem}}` per reading, each proved by `sorry` and nothing else.
- Directly above each theorem, a docstring `/-- … -/` that says in one or two sentences what the statement means in words, followed by `Assumptions:` and `Ambiguities:` lines (write `none` if there are none).
- Supporting definitions only if Mathlib has nothing suitable. Prefer Mathlib's own (`Nat.Prime`, `Finset`, `Real.sqrt`, …).

Make every quantifier, domain and hypothesis explicit. A statement that is easier or stronger than the original is wrong, however neat it looks.

Environment: {{lean}}. Check the file with the `lean_check` tool before you stop; it must elaborate with `sorry` as the only gap.

## Rules

- Do not try to prove the theorem. Do not write `axiom`, `admit` or `native_decide`.
- Never say the statement is proved, true or verified. Lean checks that it is well-typed; that is all.
- When you stop, reply with the statement and a sentence on how you read it. Theoria then runs its own check.

<!-- on-retry -->
Theoria's check of {{file}} did not pass (attempt {{attempt}} of {{max_attempts}}):

{{diagnostics}}

Fix the statement so it elaborates, keeping its meaning. Check it with `lean_check`, then stop.
