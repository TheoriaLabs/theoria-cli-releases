---
description: Compress a Lean file or theorem/lemma across verified LOC/heartbeat optimization rounds
argument-hint: <file.lean [declaration] | theorem name> [rounds] [skill=<path>|none] [--emphasis loc|clarity|balanced]
max-attempts: 3
timeout-seconds: 600
emphasis: balanced
---
Compress verified Lean proofs for Theoria, a verification-first research workspace.
{{#if whole_file}}The entire file {{file}} already verifies. Review all {{target_count}} proof targets together, including helpers and anonymous examples: {{theorems}}.{{/if}}
{{#unless whole_file}}The proof of `{{theorem}}` in {{file}} already verifies.

```lean
{{statement}}
```
{{/unless}}

Improve proof LOC and heartbeat cost{{#if clarity}} with particular attention to clarity{{/if}}, without changing the assigned statements or their context. This is round {{round}} of at most {{rounds}}; re-read and replan from the current best, not the initial proof.

Originally: {{baseline_lines}} significant LOC and {{baseline_heartbeats}} heartbeats. Current best: {{current_lines}} significant LOC and {{current_heartbeats}} heartbeats. Helper lemmas count; imports/comments do not count as LOC. Emphasis: {{emphasis}}.

{{#if request}}Guidance from the user: {{request}}{{/if}}

Environment: {{lean}}.

## How to work

- Inspect all assigned proofs, then try theorem reuse, structural refactoring, normalization, narrow deterministic tactics, reconstructed search, and minimization in that order.
- Make one significant transformation at a time. Check the complete file with `lean_check` (`theorems: {{theorems_json}}`, `measureHeartbeats: true`) and keep the last verified version. Use local proof-state/diagnostic feedback while editing. Theoria independently checks all assigned types and axioms, including anonymous examples in whole-file mode.
- Prefer a shorter, clearer, stable proof over tactic golfing. Compare elaboration cost when introducing expensive automation, and reject substantially slower or more fragile candidates.

## Rules

{{#if comparator}}- Preserve the benchmark target statements and their dependencies as checked by Comparator against the frozen challenge. Compiler-generated auxiliaries may change or disappear.{{/if}}
{{#unless comparator}}- Preserve the assigned statements, names, namespace/section context and all source-declared definitions. In whole-file mode preserve every existing theorem/lemma, including declared helpers; shorten their proofs rather than deleting declarations. Compiler-generated proof auxiliaries may change or disappear.{{/unless}}
- Do not write `sorry`, `admit`, `native_decide` or a new `axiom`.
- Moving complexity into new or rewritten helper declarations does not make it free: their proof work is measured too.
- Theoria keeps a result only when it verifies and improves the measured objective. If no worthwhile improvement remains, leave the current best unchanged and say why. Non-dominated verified tradeoffs are retained with the run's report.

Report target/scope, rounds, before/after LOC and heartbeats, versions actually checked, and a concise Transformations section. Theoria computes the authoritative metrics and round counts after checking.

<!-- on-retry -->
Theoria's check did not accept the compressed proof (attempt {{attempt}} of {{max_attempts}}):

{{diagnostics}}

The rejected draft was preserved and {{file}} restored to {{best_snapshot}}. Retry within round {{round}}/{{rounds}} from that best verified proof. All assigned targets ({{theorems}}) must keep their statements. Use local Lean feedback, then `lean_check` with `measureHeartbeats: true`; seek a worthwhile LOC/heartbeat improvement over {{current_lines}} LOC and {{current_heartbeats}} heartbeats.
