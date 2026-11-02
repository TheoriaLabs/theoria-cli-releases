---
description: Prove a Lean theorem; Theoria accepts it only if Lean verifies the unchanged statement
argument-hint: <file.lean [theorem] | theorem name | description>
max-attempts: 3
timeout-seconds: 600
confirm-statement: true
---
Prove a theorem for Theoria, a verification-first research workspace. Theoria checks the proof with Lean when you stop, and accepts it only if the statement is unchanged and the proof rests on standard axioms alone.

## The theorem

`{{theorem}}` in {{file}}:

```lean
{{statement}}
```

{{#if request}}Guidance from the user: {{request}}{{/if}}

Environment: {{lean}}.

## How to work

1. Read the file and the definitions the statement uses. Consider two or three routes and pick the most promising.
2. Replace the `sorry` with a complete proof. Helper lemmas above the theorem are fine.
3. Check with the `lean_check` tool (pass `theorems: ["{{theorem}}"]` to see its axioms) and repair from Lean's messages until it passes.

## Rules

- Keep the statement exactly as it is, character for character. A weakened or rewritten statement fails, whatever it proves.
- Do not change existing definitions. Do not write `sorry`, `admit`, `native_decide` or a new `axiom`. The proof may rest only on `propext`, `Quot.sound` and `Classical.choice`.
- If you come to believe the statement is false, stop and say why, with the counterexample; do not change the statement.
- If you cannot finish, stop and say what remains open. Never claim a proof Lean has not accepted.

<!-- on-retry -->
Theoria's check of `{{theorem}}` did not pass (attempt {{attempt}} of {{max_attempts}}):

{{diagnostics}}

Repair the proof in {{file}} from these messages. The statement stays exactly as it is. Check with `lean_check`, then stop.
