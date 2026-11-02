---
name: compress
description: >
  Refactor a verified Lean proof into a shorter, lower-heartbeat, idiomatic,
  robust proof. Supports whole-file or individual declaration compression.
  An optional final argument specifies the maximum number of compression rounds.
---

# Lean Proof Compression

Compress verified Lean proofs while preserving semantics and kernel verification.

## Invocation

Supported forms:

```text
/compress Solution.lean
/compress Solution.lean 5
```

Compress the entire file, optionally for up to 5 rounds.

```text
/compress Solution.lean Namespace.myLemma
/compress Solution.lean Namespace.myLemma 5
```

Compress one theorem or lemma, optionally for up to 5 rounds.

Syntax:

```text
/compress <file> [rounds]
/compress <file> <declaration> [rounds]
```

`rounds` must be a positive integer. Default: `1`.

Agents invoke either scope through the existing `theoria` tool.

Each round starts from the **best verified result from the previous round**, replans from the current proof state, attempts further compression, verifies and measures candidates, and stops early if no worthwhile improvement remains.

## Hard constraints

- Never change theorem/lemma statements.
- No `sorry`, `admit`, unsafe shortcuts, or new untrusted axioms.
- Every accepted candidate must pass Lean verification.
- Keep the last verified version for rollback.
- Shorter is not automatically better: optimize **proof tokens + heartbeat cost + measured compatibility**, according to the host's weights.
- Use local Lean proof-state/diagnostic feedback during editing; broader builds are final integration checks.

## Baseline

Before Round 1 record:

```text
proof LOC
heartbeats
Lean + Mathlib version
relevant dependencies
verification status
```

For whole-file compression, establish these metrics per declaration where practical and for the file overall.

## Strategy

Inspect the current proof before editing and prefer high-level transformations over tactic golfing.

1. **Reuse existing mathematics — replace derivation with a theorem the library already knows.**
   Search project code and Mathlib for stronger or near-identical results.
   ```lean
   exact theorem ...
   simpa using theorem ...
   simpa [defs] using theorem ...
   ```
   Also inspect iff directions (`.mp`, `.mpr`, `.1`, `.2`) and direct proof terms.

   For high-value structural replacements, batch two or three independent searches using complementary name, type-pattern, and semantic formulations. Consolidate the results before editing. Avoid repeating near-identical queries across rounds.

   Start Loogle and LeanFinder searches with `num_results: 10`. Retain useful names, types, and unsuccessful approaches across rounds. Compare the returned assumptions and conclusions with the actual goal, then test the strongest replacement; search results are leads, not verification. Independent calls can be issued in one tool batch, although an individual backend may serialize them or apply rate limits.

2. **Compress structure — recognize the mathematical pattern instead of shortening individual tactics.**
   Replace repetitive reasoning with higher-level structure: component equality → `ext`; manual unpack/repack → `rintro`, `obtain`, `rcases`, `refine`; unnecessary finite cases → structural arguments; implementation unfolding → public API lemmas.

3. **Normalize near-matches — make equivalent statements look identical.**
   Try `simpa`, `simp`, `simp_all`, `simp_rw`, `rwa`, and `convert`. Prefer a targeted `simp only [...]` when broad simplification is unnecessary.

4. **Use the narrowest solver — exploit the mathematical domain instead of generic search.**
   Consider `ring`, `ring_nf`, `norm_num`, `linarith`, `nlinarith`, `omega`, `positivity`, `norm_cast`, and `exact_mod_cast`. Avoid solver × case-split explosions.

5. **Reconstruct the proof — use search to discover compact proofs, then retain only efficient results.**
   Try `exact?`, `apply?`, `simp?`, `aesop?`, `grind?`, and LeanHammer. Treat broad automation mainly as discovery; prefer reconstructed explicit/restricted proofs when practical.

6. **Minimize mechanically — remove everything Lean proves is unnecessary.**
   Delete redundant `have`s, rewrites, simplifications, branches, and intermediate facts; re-elaborate after each change. Replace multi-line regions with established Mathlib idioms.

## Heartbeat optimization

Measure heartbeats after every significant verified candidate.

Scrutinize especially:

```text
interval_cases / large fin_cases
large simp_all calls
broad aesop / grind / LeanHammer search
nlinarith or omega across many branches
aggressive unfolding
large simp sets
```

Prefer transformations that reduce search:

```text
direct theorem application
deterministic rewriting
small simp sets
stronger intermediate lemmas
algebraic reformulation
explicit key deductions before automation
```

Do not accept a large heartbeat regression merely for a small LOC reduction unless the active scoring objective justifies it.

## Candidate selection

For each valid candidate record:

```text
proof LOC
heartbeats
version compatibility
compress_score (%)
```

For Theoria, report each round and each submitted candidate against the original baseline:

```text
compress_score = w_tokens * token_reduction + w_heartbeat * heartbeat_reduction
              + w_compatibility * compatibility_percent + w_loc * loc_reduction
default weights: w_tokens = w_heartbeat = w_compatibility = 1/3, w_loc = 0
```

Reductions are percentages, calculated before rounding. The weights are configurable and sum to one.
Proof tokens exclude statements, comments and blank lines, using the host's recorded tokenizer. New helper
proofs count; new non-proof helper declarations count in full. Compatibility is the absolute fraction of the
fixed environment matrix that actually passed, not a reduction from the original. Retain non-dominated
candidates on the active axes; use `compress_score` to rank them. The host's weights override these defaults.
An unverified or unmeasured candidate has no valid score and must be reported as such.

For Lean Refactor Arena, optimize:

```text
mean(
  length reduction %,
  heartbeat reduction %,
  zero-shot compatibility %
)
```

Keep Pareto-improving candidates when proof-token length, heartbeat cost and measured compatibility trade off.

## Multi-round policy

For rounds `1..N`:

```text
current best verified proof
        ↓
re-read proof + goal state
        ↓
re-run theorem / Mathlib idiom search
        ↓
plan highest-value transformation
        ↓
apply one or more coherent changes
        ↓
Lean verify + measure
        ↓
accept best improvement
        ↓
next round
```

Replan from scratch after every successful round. A structural rewrite may expose new theorem reuse, simplification, or solver opportunities.

Stop before `N` when:
- no valid candidate improves the current result;
- only negligible improvements remain;
- further shortening materially worsens heartbeats or robustness.

For whole-file mode, each round should reconsider the **entire file**, prioritizing declarations with the largest remaining compression or heartbeat opportunity.

## Human Mathlib patterns

Prefer established patterns such as:

```lean
by simpa using h
```

```lean
by
  ext
  simp
```

```lean
by
  obtain ⟨x, hx⟩ := h
  refine ⟨x, ?_⟩
  ...
```

```lean
by
  convert existing_theorem ... using 1 <;> simp
```

and direct theorem terms when possible.

Search human-written Mathlib proofs with similar goal/type shapes when useful.

## Project-level opportunities

If normalization repeats across proofs, test:

```lean
simp [helper]
```

then, if broadly useful:

```lean
attribute [local simp] helper
```

Only propose permanent `@[simp]` when the rewrite has a canonical direction, benefits multiple proofs, terminates well, and does not degrade unrelated simplification.

## Final verification

Confirm:

```text
✓ statements unchanged
✓ Lean elaboration succeeds
✓ no sorry / sorryAx
✓ heartbeat counts measured
✓ required Lean/Mathlib versions compile unchanged
```

Run broader module/project checks when appropriate.

Report:

```text
Target:
  file
  declaration or whole-file

Rounds:
  requested / completed

Before:
  proof LOC
  heartbeats

After:
  proof LOC
  heartbeats
  compress_score (%)

Compatibility:
  versions passed

Transformations:
  concise summary
```
