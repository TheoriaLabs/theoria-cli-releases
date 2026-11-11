# Theoria CLI

A lightweight Theoria harness on top of the [Pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).
`theoria` runs Pi's own command line with Theoria's packages loaded: Lean and Mathlib selection (`/lean`), and
prompt-driven workflows whose results Lean decides (`/formalize`, `/prove`, `/compress`).

## Install

```bash
curl -fsSL https://www.theoria.sh/install/cli.sh | bash
theoria version
theoria                # interactive; `theoria -p "…"` for one prompt
```

The installer downloads the latest release from
[TheoriaLabs/theoria-cli-releases](https://github.com/TheoriaLabs/theoria-cli-releases), verifies its SHA-256
checksum, installs it into `~/.theoria-cli/app/<version>` (with `~/.theoria-cli/app/current` pointing at it), runs
`npm ci --omit=dev` there, and links `~/.local/bin/theoria`.

- **Requirements:** Node.js 22.19 or later with npm, plus `curl`, `tar` and `shasum` or `sha256sum`. macOS is
  supported. On Linux the installer continues with a warning: the Telegram bot sandbox (`sandbox-exec`) and
  copy-on-write benchmark environments are macOS-only. Lean is installed later from inside Theoria (`/lean install`)
  and needs [elan](https://github.com/leanprover/elan).
- **Options:** `THEORIA_VERSION=0.1.0-beta.1` installs that version; `THEORIA_INSTALL_DIR` and `THEORIA_BIN_DIR`
  change the two locations. For example: `curl -fsSL https://www.theoria.sh/install/cli.sh | THEORIA_VERSION=0.1.0-beta.1 bash`.
- **Upgrade:** run the installer again. It keeps the previous version alongside the new one and removes older ones.
  Your settings, sessions and credentials in `~/.theoria-cli/agent` and `~/.theoria-cli/config.json` are never
  touched.
- **Uninstall:** `rm -rf ~/.theoria-cli/app ~/.local/bin/theoria`. Remove `~/.theoria-cli` too to delete your
  settings, sessions, Lean toolchains and benchmark data.

`theoria version` prints the version and commit (from `release.json` in an installed copy, from git in a checkout).

## From source

```bash
npm install
npm start            # interactive
npm start -- -p "…"  # one prompt, print mode
npm link             # optional: put `theoria` on PATH
npm run check        # typecheck and tests
```

Pi's configuration, sessions and credentials live in `~/.theoria-cli/agent`, separate from a personal `~/.pi`.

Inside Theoria, **`/help`** lists the slash commands this session has, grouped, each with its forms:
`<value>` is required, `[value]` optional, `a|b` one of them. `/help <command>` shows one command in full. The help
card appears in the conversation but is never sent to the model.

### Releases

`npm run release -- <version>` builds `dist/theoria-cli-<version>.tar.gz`, `SHA256SUMS` and `VERSION` from the
committed tree (development files are excluded via `.gitattributes`), adding `release.json`. The version must match
`package.json`. Pushing a tag `v<version>` runs [`.github/workflows/release.yml`](.github/workflows/release.yml),
which builds, checks that the archive installs and runs, pushes a source snapshot and tag to
`TheoriaLabs/theoria-cli-releases`, and publishes the GitHub release there. It uses the TheoriaLabs Release Bot app
(`vars.RELEASE_APP_ID`, `secrets.RELEASE_APP_PRIVATE_KEY`). Pre-release versions are published as normal releases so
that the installer's `releases/latest` finds them.

## Development workflow

Use **`feat/*` → pull request → `develop`** for all changes, including agent-authored changes:

1. Create `feat/<short-description>` from an up-to-date `develop` before editing.
2. Implement the change and run the relevant checks (`npm run check` for code changes).
3. Commit and push the feature branch.
4. Open a pull request targeting `develop`, summarizing the changes and test results.
5. Merge into `develop` after review. Keep development commits on feature branches.

## Configuration

Every setting is in [`theoria.config.json`](theoria.config.json): paths, the default Bedrock model, the welcome
screen, Lean timeouts and limits, the Mathlib repository, workflow defaults and matching thresholds. Each section's
`$comment` says what it governs. It is validated at startup, and a test fails if any setting is not read by the code.

To change a value, put just that key in `~/.theoria-cli/config.json` (or the file named by `THEORIA_CONFIG`).
Objects merge into the defaults, lists replace them. An unknown key, a wrong type or an out-of-range value stops the
CLI with the key named:

```json
{ "workflows": { "defaults": { "maxAttempts": 5 } }, "bedrock": { "defaultModel": "us.anthropic.claude-opus-5" } }
```

`PI_CODING_AGENT_DIR`, `THEORIA_LEAN_HOME`, `ELAN_HOME` and `THEORIA_BEDROCK_MODEL` still override their settings.

### Bedrock Ultrafast models

Theoria adds **GPT-6 Astra (US) Ultrafast** and **GPT-6.1 Sol (US) Ultrafast** to Pi's Amazon Bedrock model list.
Restart Theoria after installing this update, then select either model:

```text
/model amazon-bedrock/us.openai.gpt-6-astra-ultrafast
/model amazon-bedrock/us.openai.gpt-6.1-sol-ultrafast
```

Or start directly with `theoria --model amazon-bedrock/us.openai.gpt-6.1-sol-ultrafast`. Both aliases use existing
Bedrock authentication and send their real model IDs (`us.openai.gpt-6-astra` or `us.openai.gpt-6.1-sol`) with
`additionalModelRequestFields.service_tier = "ultrafast"`. The aliases are available across harness profiles and
trial subprocesses; registration adds no tools or prompt instructions. Pi's normal Bedrock catalog refresh is retained.

Session messages retain each Ultrafast alias so cost accounting identifies the selected mode. Rates in USD per
million tokens come from the models.dev Ultrafast mode catalog (October 11, 2026), replacing standard-model rates:

| Model | Input | Output | Cache read | Cache write |
|---|---:|---:|---:|---:|
| GPT-6 Astra (US) Ultrafast | $66 | $330 | $6.60 | $82.50 |
| GPT-6.1 Sol (US) Ultrafast | $13.20 | $66 | $0.66 | $16.50 |

`bedrock.ultrafast.enabled` controls all registration. Existing Astra name, IDs and prices remain at
`bedrock.ultrafast`; `bedrock.ultrafast.additionalModels` configures the Sol alias. Setting `additionalModels: []`
keeps only Astra. Existing Astra overrides keep working.
The selected tier is sent on every request; a rejected Ultrafast request reports Bedrock's error rather than
silently retrying at the standard tier. This integration works with the installed Pi 1.0.2.

## Projects: `/new-project`, `/project`

`/new-project [name]` asks for a name and a type, and for a mathematics or physics project which Lean and Mathlib to
use (the same choice as `/lean config`, or later). It creates `./theoria-projects/<name>/` (`project.parentDir`,
relative to where `theoria` was started) with a git repository, a `.gitignore`, the type's scaffold folders and
`.theoria/project.json`, then moves the session into it. It never writes into a folder that already has files.

The type decides which Theoria commands a project gets (`projectTypes` in the configuration):

| Type | Commands |
|---|---|
| `mathematics` | `/formalize` `/prove` `/compress`, `/lean`, `/latex` |
| `theoretical-physics` | `/formalize` `/prove`, `/lean`, `/latex` |
| `ai-ml`, `quant-finance`, `other` | `/latex`, Pi and rendering |

`/project` opens a menu; each entry also works typed directly:

- `/project list` lists the projects in `./theoria-projects` (plus the current folder when it is a project elsewhere,
  `project.listShowOutside`), each with its type, proofs and last activity, the current one marked `●`. Choosing one
  switches the session into it, resuming its last conversation or starting a new one; the commands follow its type.
- `/project status` shows what Lean says about the project's `.lean` files: every theorem, well-formed or with a
  statement error, proved, open (`sorry`, or depending on one) or with a proof error; then the Lean target's
  progress, the open goals and the recent workflow verdicts (`.theoria/verdicts.jsonl`). The Lean result is cached per file
  (`.theoria/theorems.json`, `workflows.inventory`) with its age; when a file changed, Lean rechecks in the
  background and says when it is done. `/project status refresh` waits for the recheck. A missing toolchain or
  Mathlib shows as unavailable, not as failures.
- `/project type [type]` changes the type and reloads so the commands match.
- `/project new [name]` is `/new-project`.
- `/project servers` chooses which MCP servers this project type loads (see below).

A folder without a project file uses `project.defaultType` (`mathematics`); `theoria --project-type <type>` overrides
the type for one run. A user config may add types (`projectTypes.<name>`, shaped like `other`).

## MCP servers and Mathlib search: `/mcp`, `/lean search`

MCP is Pi's own: `/mcp` shows the servers, their tools and state, and turns a server off or on (saved to `mcp.json`,
or with "Disable in this project" to the project's `.pi/mcp.json`). Servers come from `~/.theoria-cli/agent/mcp.json`
and, in a trusted project, `.pi/mcp.json` (`theoria mcp add|remove|list` edits them). Theoria then applies the
project type (`projectTypes.<type>.mcpServers` and `otherServers`):

- a server Theoria manages loads only in the types that list it, with the tools named in `directTools` declared to
  the model as tools of their own;
- servers you added load in every project, unless the type's `otherServers` is `hide`, where only the listed ones do;
- servers a project defines in its own `.pi/mcp.json` always load there.

`/project servers` changes both for the current type and saves them to your config file. Switching project or type
starts the session again, so its servers follow. `theoria mcp list` shows every configured server, unfiltered.

**Mathlib search** is [lean-lsp-mcp](https://github.com/oOo0oOo/lean-lsp-mcp) as the server `lean-lsp`, listed for
mathematics and theoretical physics. `/lean search install` installs the pinned version (`leanSearch`, with uv and a
Python of its own, about 130 MB) into `~/.theoria-cli/agent/lean-lsp-mcp` and adds the server to `mcp.json`;
`/lean search remove` takes both away; `/lean search status`, `/lean status`, `/project status` and the welcome
screen show whether it is on, off, not installed, or unavailable (and why, such as no Mathlib chosen).

- It searches the session's Mathlib checkout (or the folder's own Lean project) and offers three search tools: Loogle
  (names, constants, type patterns), Lean Finder (natural language), and local search (exact names, offline).
  The baseline `theoria` profile disables the other server tools (`leanSearch.disabledTools`). The default
  `theoria-lsp` profile adds proof inspection plus isolated `lean_multi_attempt`, `lean_code_actions`,
  `lean_run_code`, and `lean_profile_proof` probes; their MCP names are added to its trial allowlist automatically.
- Loogle and Lean Finder are remote services: the agent's queries leave this machine, about 3 requests per
  30 s each. `leanSearch.localLoogle` runs Loogle locally instead (an index per Mathlib version, minutes to build,
  about 13 GB of memory).
- The agent is told that a search result is a lead, to be confirmed with `lean_check`, never evidence.
- Pi starts it as `theoria mcp-launch lean-lsp`, which removes every key and token variable from its environment
  (`sandbox.secretEnvPattern`). Where it cannot run, it is a server with no tools whose instructions say why.

Loogle and LeanFinder default to **10 results** (`leanSearch.topK`); an explicit `num_results` overrides that
default. A small Theoria launcher adapter applies the default to both the advertised MCP schema and actual calls,
without editing the installed lean-lsp-mcp package. Reconnect the server or restart Theoria after updating.

Lean MCP requests have a **180-second minimum window** (`leanSearch.requestTimeoutSeconds`). The minimum
applies at session load to Theoria-managed servers, including older `mcp.json` entries and isolated workers;
explicitly longer server timeouts are preserved. For slower projects, set for example
`{"leanSearch":{"requestTimeoutSeconds":300}}` in your Theoria user config and restart/reload the session.
Individual tools can also have internal limits; increasing this outer window does not change those limits.

Cold batch requests pay for Lean startup, original-file elaboration and scratch-file elaboration. The current
upstream scratch pool defaults to one slot, so alternatives are checked sequentially. Usually try 3–5 distinct
candidates. Use smaller batches for cold or expensive goals, and larger batches when measured latency permits.
Avoid redundant candidates and split batches that approach the request timeout. Use focused scratch files
when practical. Refresh edited line positions, preserve tactic
indentation and use `#count_heartbeats tac` inside tactic snippets, not the command form `#count_heartbeats in`.
An unchanged retry of a timed-out batch is usually less useful than a smaller or better-isolated probe.

Loogle combines filters with **commas (AND)**: `"Matrix", "mul_comm"` is valid, while `"Matrix" "mul_comm"`
and `Matrix "commute"` are malformed. Quote name substrings (`"mul_comm"`); keep known constants unquoted
(`Real.sin, "add"`). Use Lean Finder for natural-language searches. The unavailable LeanSearch backend is disabled
at the MCP server and omitted from default project and benchmark tool lists.

For local tactic screening, `lean_multi_attempt` accepts snippets such as `#count_heartbeats omega` when the
counting tactic is imported. Its info diagnostic is in raw ticks: divide by 1,000 for Theoria heartbeat units.
Exclude the wrapper from proof-token measurement. Errors, open goals and `sorry` warnings are not completed
proofs; full-file preservation, token/HB measurement and host verification still decide acceptance.
`lean_profile_proof` reports milliseconds and may fail on same-file helper dependencies; use the host's full-file
profile for those cases. Code actions return edits to apply and verify, rather than changing the file themselves.

For high-value structural replacements, the compression skill and search-tool descriptions recommend batching
**two or three independent searches** with complementary name, type-pattern, and semantic queries. Consolidate
results before editing and retain discoveries across rounds instead of repeating near-identical queries.
Parallel dispatch does not remove a backend's rate limits or local Loogle's single-process serialization.

## Harness profiles: `--harness`, `theoria harness`

A profile (`harness.profiles`) lists which of Theoria's components a session loads; a component that is off is not
loaded at all, so its tools, instructions and commands are absent. `theoria harness` lists the profiles and what
each component adds. Shipped:

| Profile | Components | Use |
|---|---|---|
| `theoria` | all: welcome, tui, project, actions, agents, lean, search, mcp, workflows, latex, research, plan, bench, autoresearch, telegram, goals, render | the original comparison baseline |
| `theoria-hammer` | same as `theoria`, plus `leanExtras: ["hammer"]` | LeanHammer for compatible projects and benchmark trials |
| `theoria-lsp` (default) | same as `theoria`, plus `leanLspTools` | Tactic goals, expected expression types, hover information, and diagnostics |
| `lean` | lean | Pi plus `lean_check` and the Lean instructions |
| `bare` | none | Pi as it ships: Pi's tools and prompt, no MCP servers |

`theoria --harness bare` for one session (or `THEORIA_HARNESS`); `harness.default` otherwise; a user config may add
profiles. The model, credentials and the bot's sandbox, file guard and secret stripping are the same under every
profile; they add nothing to the context.

Benchmarks run under a profile: `/benchmark run smoke train 2 harness=bare`. A trial loads only
`harness.trialComponents` of its profile (lean, search, mcp), plus plan/goals where requested, and only the profile's
`trialTools`. The task prompt is the same words for every profile; tool guidance comes from the harness. Each trial records the input tokens of its
first model call, what the harness puts in front of the task. `/benchmark compare <run> <run>` shows two runs side by
side (solved, cost, cost per solved task, wall-clock, tokens in and out, first-call context, tasks only one solved)
and refuses runs that differ in anything but the harness: benchmark version, split, tasks, model or limits.

### LSP-enhanced proof work

`theoria-lsp` is the default for new interactive sessions, benchmark runs and `/autoresearch` campaigns.
Use `theoria --harness theoria` or `harness=theoria` in a benchmark command
to select the original comparison baseline. Explicit choices override `harness.default`; each run and campaign
manifest freezes the selected profile.

| Tool | Feedback |
|---|---|
| `lean_goal` | Local hypotheses and goals at a tactic position; omit the column for before/after states |
| `lean_term_goal` | Expected type at an expression or hole, useful for `refine`, implicit arguments, and casts |
| `lean_hover_info` | A symbol's type signature and documentation |
| `lean_diagnostic_messages` | Current compiler errors, warnings, and suggestions |

`harness.profiles[].leanLspTools` is the single profile-scoped list controlling server enablement,
direct tool exposure, and the additional benchmark `trialTools`. Custom profiles can select a subset
of supported read-only LSP tools; they need the `lean`, `search`, and `mcp` components. Existing custom
profiles that omit this field keep their original behavior. Project/server disable settings and explicit
MCP exposure overrides are respected. No changes to global `mcp.json` are required.

Goal queries use 1-indexed positions and the current saved file. Finish edits before querying their
results. A locally complete goal does not establish that the whole file verifies or that compression
improved: `lean_check`, preservation checks, measurements, and Comparator remain authoritative.

## Research runs, claims and artifacts: `/attack`, `/claim`, `/artifact`

A **research run** is one bounded research effort in a project, with a persistent goal (objective, success
criteria, current focus, notes) kept in `.theoria/runs/<run>/run.json`, not in a conversation. `/attack new <objective>`
starts one in a new conversation; `/attack fork [objective]` branches a new run from the current one (the project's
claims and artifacts carry over, the conversation does not); `/attack resume`, `/attack pause`, `/attack complete`,
`/attack status`, `/runs` (with forks). While a conversation belongs to a run, its goal and the most relevant claims,
artifacts and events are added to the agent's instructions each turn. A run records the harness it ran with (model,
Pi and Theoria versions, project type, packages, system prompt hash) and an append-only event log
(`events.jsonl`: verdicts, claims, artifacts, goal changes). `/attack new` can also start pi-goal-x on the goal; pi-goal-x
marking it complete is recorded as the agent's and auditor's judgement, and only you complete a run.

**Claims** (`/claim`, `/claims`) are project knowledge, every version kept in `.theoria/claims.jsonl`; **artifacts**
(`/artifact add <path>`, `/artifacts`) are project files with the run that produced them and their content hash. A
workflow that passes registers its file as an artifact. A claim is *hypothesis*, *supported* or *refuted* by
judgement (yours or the agent's, shown as such), and **verified only by Theoria**:

- **formal**: `/claim link <id> verifies <file.lean>:<theorem>` (or `/claim verify <id>`): Lean's check of that file
  has the theorem proved, without `sorry`, with the standard axioms;
- **statistical**: `/claim test <id> <data file> <test>`, with `mean <col> > <mu0>`, `welch <a> > <b>`,
  `paired <a> > <b>` or `binomial <col> > <p0>` (CSV, TSV, JSON or JSONL): Theoria computes the one-sided test from
  the raw values (never from a reported p-value) and the claim is verified when it reaches `research.statistical.sigma`
  (5σ, p ≈ 2.9·10⁻⁷) after a Bonferroni correction over every test tried on that claim, so retrying until one passes
  does not pay. Shown as e.g. `verified (statistical, 6.1σ ≥ 5σ, Welch t)`: evidence under the test's assumptions,
  not proof; how the data was produced is recorded, not checked.

When the linked file changes, the claim drops back to *supported (verification stale)*.

### Next steps for papers: `/next-steps`

`/next-steps <arxiv-id | url | file | topic> [more papers…] [--n <1-10>] [--focus theory|numerics|formalization]`
asks the agent to expand on a paper, several papers, or a line of research:

```text
/next-steps 2401.01234
/next-steps paper.pdf 2312.04567 --n 5
/next-steps "sphere packing in dimension 8" --focus formalization
```

The agent fetches the papers (arXiv API, abstract and HTML pages, or local PDF, LaTeX, Markdown and Lean files; for a
topic, its central recent papers) and 5–10 related or citing works, same authors first, listed with links. It gauges
where recent activity is growing, distills the contributions, methods and stated open questions, and proposes
extensions. Each has a one-line idea, why it is new relative to the gathered works, a type, a concrete first step (a
computation, experiment, lemma or Lean statement), difficulty and risk. It ranks them, recommends the top one or two,
and offers `/claim new hypothesis`, `/formalize` or `/attack new` for the ones you choose. It cites only sources it
fetched and records nothing on its own.

- `--n <k>` asks for exactly *k* ideas (1–10; default 5–8).
- `--focus theory | numerics | formalization` biases the ideas toward new theorems and bounds, toward computation and
  experiments, or toward Lean 4/Mathlib statements, weighing recent momentum within that kind of work.

Options may appear anywhere; everything else is passed through as typed, quotes included. The request is sent to the
agent as an ordinary message, so it uses the session's model and tools; while the agent is busy it is queued after
the current turn. The prompt is
[`packages/theoria-research/prompts/next-steps.md`](packages/theoria-research/prompts/next-steps.md); copy it to
`.theoria/commands/next-steps.md` (this project) or `~/.theoria-cli/agent/commands/next-steps.md` (all projects) to
change it. It takes `$ARGUMENTS`, `$1`…, `{{count}}`, `{{focus}}`, `{{focus_guidance}}` and `{{#if focus}}…{{/if}}`;
a prompt that leaves any of these out still receives the request and options, appended at the end.

## Plans: `/plan`, the `plan` tool

A research run (and a benchmark trial) can have a plan: how it means to reach its objective, as a small graph.
Attack angles are alternative routes, one active, each with its rationale and main risk; nodes are definitions,
lemmas, theorems and milestones, with their dependencies. The agent keeps it with the `plan` tool (create, add,
edit, remove, angle, link, switch, abandon, done, show, check); every change is a new version, so the plan follows
the run as it learns. The plan's open nodes are a `<plan>` section of the agent's instructions each turn.

A node's status comes from its evidence, never from the agent: a node linked to a Lean declaration
(`Solution.lean:name`) is proved when Lean proves it; one linked to a claim, when the claim is verified (formally
or statistically); an unlinked milestone may be marked done, shown as the agent's judgement.

Two categories, chosen by the project type unless named:

- **lean** (Lean-checked): a proof skeleton. Valid when it has at least `plan.minAngles` angles, its definitions
  and lemmas are stated in the Lean file, and the target theorem is proved from them, so it is open only through
  them (Lean reports it "depends on sorry", not "uses sorry").
- **vision**: a strategic research graph for AI/ML, quantitative finance or any project without Lean. Its shape is
  checked (angles, milestones on the active angle, claims that exist), not by Lean.

A run's plan lives in its run folder (`.theoria/runs/<run>/plan.json`); `/plan` shows it, `/plan check` asks Lean.

**In benchmarks** (`harness.profiles[].trialPlan`): `required` for the `theoria` profile. A trial that stops with
sorry left is asked for a valid proof plan (what the check found missing goes back, up to `plan.planRounds` times),
and with one it is kept on the plan's next nodes until they are proved, every angle is abandoned, or
`plan.stallRounds` continuations bring no progress. Trials record their plan (valid, angles, nodes, proved) and end
as `no-plan` or `planned` when they fail. A file that still uses sorry is not sent to Comparator.

## The agent's Theoria commands: the `theoria` tool

Commands that fit a research flow are also the agent's, through one tool, `theoria`: the same definition as the slash
command, with a structured result (a Lean verdict, a claim's state), never a summary to take on trust. `actions.model`
in the configuration says per command and per surface (terminal, bot, benchmark trial) whether the agent may run it
(`allow`), must ask you (`ask`; refused where no one can answer) or may not (`deny`); a command not listed is denied.
Listed now: `/formalize`, `/prove`, `/compress`, `/claim(s)`, `/artifact(s)`, `/attack status`, `/attack update`
(focus, notes, ready for review), `/attack fork` (asks), `/project status`, `/lean status`, `/benchmark list|status`,
`/benchmark run` (asks: it costs money). Installing, switching project or type, MCP and the Telegram connection are
never the agent's.

`/prove` and the other workflows prompt the agent themselves, so the tool queues them: they start when the agent ends
its turn and their verdict comes back to it as a message. While one runs the agent cannot start another (depth 1);
at most `actions.maxDeferredPerSession` per session; the same call `repeatLimit` times in a row asks you first.
A new command reaches the agent by providing an action (`provideActions` in `@theoria/shared/actions`) and listing
it in `actions.model`.

## Independent subagents: `subagent`, `/subagent`

Ask the main agent to delegate a task, for example “Spawn a subagent to review the parser while you inspect
the tests.” The `subagent` tool works in ordinary Theoria sessions, independently of `/autoresearch` and
`/benchmark`. Its `agents` harness component can be enabled without either workflow.

```json
{"action":"start","task":"Review the parser for edge cases and report findings","mode":"read"}
{"action":"wait","id":"subagent-001"}
{"action":"result","id":"subagent-001"}
```

`start` returns immediately. Other actions are `list`, `status`, and `cancel`. To delegate implementation,
select `mode="write"`; optional `cwd` must stay inside the current project. The child receives only its task
and explicit `context`, with its own conversation. Model and thinking default to the parent's current
selection; `model`, `cost`, `turns`, and `timeout` can be specified per task.

Read mode makes the project read-only in the OS sandbox, including for shell commands; the child can write
its own scratch files. Write mode permits project edits. Coordinate parallel tasks so they do not edit the
same files. Children receive relevant Lean/search tools from the chosen harness, but do not receive the
delegation or benchmark-control tools.

Completion posts a result notice back to the parent. `wait` waits up to 60 seconds and returns current state;
interrupting a wait does not cancel the child. Full results and transcripts remain under
`.theoria/subagents/subagent-NNN/`. Closing or switching the parent session cancels its active children.

Human controls are also available:

```text
/subagent start Review the parser and summarize findings
/subagent list
/subagent status subagent-001
/subagent result subagent-001
/subagent cancel subagent-001
```

Defaults in `subagents`: three simultaneous children, $3 / 80 responses / 20 minutes per child, and
$20 / 20 tasks across a parent session. Exported provider credentials and registered Keychain secrets use
the existing worker credential loader; configured Bedrock profiles use the refreshable broker. Credentials
are not copied into task records or the child's empty Pi auth file.

## Benchmarks: `/benchmark`

| Benchmark | Tasks | Lean, Mathlib |
|---|---|---|
| `smoke` | 6 core-Lean theorems, to check the harness | Lean 4.28.0, no Mathlib |
| `minif2f` | 488 primary problems: 244 val + 244 test; [DeepMind's corrected Lean 4 formalization](https://github.com/google-deepmind/miniF2F) @ `f0a20e14c1ee` | Lean 4.27.0, Mathlib v4.27.0 @ `a3a10db` |
| `putnambench` | 672 Putnam problems (answers written into the statements), [trishullab/PutnamBench](https://github.com/trishullab/PutnamBench) | Lean 4.33.1, Mathlib v4.33.1 @ `0df444a` |
| `putnam2025` | 12 Putnam 2025 problems: **6 train (A1–A6) + 6 test (B1–B6)**, from the same pinned PutnamBench source | Lean 4.33.1, Mathlib v4.33.1 @ `0df444a` |
| `putnambench-30` | **PutnamBench-30:** 30 fixed problems excluding all 2025 tasks, **15 train + 0 val + 15 test** | Lean 4.33.1, Mathlib v4.33.1 @ `0df444a` |
| `formalqualbench` | 23 graduate qualifying-exam theorems, from scratch, [math-inc/FormalQualBench](https://www.math.inc/formalqualbench) | Lean 4.28.0, Mathlib v4.28.0 @ `8f9d9cf` |

`/benchmark install <id>` fetches the pinned source, freezes its splits, prepares the Lean environment and builds the
judge; `/benchmark list` shows each with its splits and compatibility. `/benchmark run <id> [train|val|test] [N or
task,task] [model=<provider>/<id>] [harness=<profile>] [thinking=<level>] [repeat=k] [cost=$] [concurrency=c] [timeout=min]` shows what will run and at most what it costs, and
starts after you confirm. `/benchmark status [run]`, `compare <run> <run>`, `resume`, `cancel`.

Select a model for an individual proving or compression run with `model=<provider>/<id>`:

```text
/benchmark run smoke train 2 model=amazon-bedrock/us.openai.gpt-6-astra-ultrafast
/benchmark run smoke train 2 model=amazon-bedrock/us.openai.gpt-6.1-sol-ultrafast
```

Use the full provider/model ID from `/model`, including any slashes inside the model ID. Terminal and agent
launches check it against the session's registry, including custom models and aliases. Omit `model` to use the
current session model. The selected model appears in the confirmation and run records, and is reused for all
trials, retries and resumes. Each override applies only to that run; it does not switch the session model.

The agent's `theoria` tool accepts the same option in a `benchmark-run` action:

```json
{"action":"benchmark-run","args":"smoke train 2 model=amazon-bedrock/us.openai.gpt-6.1-sol-ultrafast cost=1"}
```

To evaluate several models, ask the agent to submit one launch per model with explicit IDs. Each run has its own
confirmation and budget. Telegram's `/benchmark_run` accepts the same `model=` option.

Append extra literal instructions with `prompt-append="..."`, in proving or compression mode:

```text
/benchmark run smoke train 2 prompt-append="Prefer direct library lemmas and explain the final proof briefly."
/benchmark run formalqualbench train mode=compress corpus=corpus.json rounds=2 prompt-append="Finish edits before checking; prioritize theorem reuse."
```

The text is shown in the run plan and stored with the run. It is appended to the main task prompt and to each
compression round/repair prompt, and reused by resumed/retried trials. Compression runs also freeze it in their
hashed inputs. Text such as `{{round}}` and `$1` stays literal; this parameter supplies text, not a file path.
Use one nonempty `prompt-append` argument, with straight quotes around text containing spaces.

Attach reference files with `context-dir=<directory>`:

```text
/benchmark run formalqualbench train context-dir=.theoria/project-indexes prompt-append="Use the supplied indexes for navigation; verify replacements in the pinned environment."
```

The directory is read while planning, then snapshotted once under the new run's `inputs/context/` with a
content-hashed manifest. Every proving or compression worker receives read-only files at `inputs/context/`
and a complete file list at `inputs/context-manifest.json`. The prompt lists available references automatically.
Copies use copy-on-write where supported; retries and resumes use the same snapshot even if the original
directory changes or is deleted. Only the worker-local reference paths are exposed; no parent-project read
grant is added. Frozen files are checked for modification before use.

Paths are relative to the command's working directory (absolute and `~` paths also work). Quote directories
containing spaces. The directory must contain regular files, without nested symlinks or special files, and fit
within 4096 files / 64 MiB. Use `context-dir` with new runs; it does not change an existing run's frozen inputs.

The default model budget is **$3 per task trial** (`benchmarks.defaults.maxCostUsd`); `cost=<USD>` overrides it
for a new run. Six tasks with one repetition have a default maximum budget of **$18**.

Run numbers share a project-wide namespace across `.theoria/runs/` and `.theoria/benchmarks/` (or their configured
locations). Existing entries reserve their numbers even when created manually or missing metadata. For example,
a manually created `.theoria/benchmarks/run-005/` makes the next run at least `run-006`. New benchmark runs reserve
fresh directories under the project lock before writing metadata; existing run contents are never reused.

- **Splits.** Every task is in *train*, *val* or *test* (`benchmarks.splits`, 60/20/20 by a seeded hash), frozen in
  the benchmark's manifest at install so tasks never move. A run is on one split; *test* asks first and its trials
  are marked sealed, for reporting only.
  miniF2F keeps its official **val/test** assignments and has no train split; its twelve additional `.variants.`
  declarations are excluded. Putnam2025 uses Theoria's fixed **A1–A6 train / B1–B6 test** partition, with no val
  tasks. The same labels are declared in PutnamBench and stored in its shared manifest, so a problem cannot be
  training data in one view and a held-out test in the other. It shares the source installation
  and environment too; the 12 tasks retain their `putnam_2025_a1` … `putnam_2025_b6` IDs.
  PutnamBench-30 similarly shares its parent's source, environment and labels. Its
  [fixed membership](packages/theoria-bench/src/benchmarks/putnambench30-tasks.ts) was selected from the 660
  non-2025 tasks: within the parent's `theoria-splits-v1` train and test groups, rank IDs by
  SHA-256(`putnambench-30-v1:${id}`) and take 15 per group. Membership is committed, not resampled at runtime;
  the competition's A/B problem labels do not determine the split. Existing conflicting parent labels fail
  explicitly instead of being silently changed.
- **Exact Lean.** A benchmark runs only on a Mathlib checkout at its exact commit and toolchain, never a near match;
  otherwise it is unavailable and says what to install. The checkout is cloned copy-on-write (APFS, no extra disk)
  into `~/.theoria-cli/agent/benchmarks/envs`, so your checkout is never written. Trials and judging are Lake projects
  with the benchmark's own `leanOptions`; `lean_check` in a Lake project now runs `lake lean`, which applies them
  (`lake env lean` does not).
- **Trials.** Each task is a separate Theoria session in the bot's sandbox, in its own Lake project, with only
  `benchmarks.trialTools` (files, bash, `lean_check`, Mathlib search), no goals and no Theoria commands, ended by the
  time, turn and cost limits. A model or setup failure is retried (`retries`); a failed proof is not, though the
  agent gets Comparator's rejection back up to `feedbackRounds` times within the limits.
- **Judge.** [Comparator](https://github.com/leanprover/comparator): the untouched challenge and the solution are
  built in a fresh folder, and a trial passes only with the same statement (and every definition it uses), the
  standard axioms, and the kernel's acceptance. This catches axioms injected by metaprogramming, which a compile check
  does not. Comparator sandboxes with landrun, Linux-only; on macOS `packages/theoria-bench/bin/landrun` enforces the
  same command line with sandbox-exec (writes, network and environment confined).
  Comparator 4.27 uses a separately pinned, format-compatible `lean4export` commit, built with Lean 4.27.0 and
  checked on a real proof during installation. miniF2F's four utility modules (including `answer(...)` and
  `Real.nthRoot`) are copied from its pinned source/dependency into each trial and fresh judge workspace; other
  benchmark theorem declarations and upstream proof bodies are excluded from the task.
- **Results** per trial and per run: pass/fail as Comparator judged, cost (provider-reported), wall-clock time, tokens
  in (uncached, cache read, cache write) and out, turns; per run also cost per solved task and the runner's
  wall-clock time. A benchmark run is a research run of kind *benchmark*: its trials, solutions, Comparator logs and
  transcripts are artifacts, in the gitignored `.theoria/benchmarks/` (the benchmarks ask that solutions are not
  published).

Examples for the new suites:

```text
/benchmark install minif2f
/benchmark run minif2f val 2
/benchmark run minif2f test 244
/benchmark install putnam2025
/benchmark run putnam2025 train
/benchmark run putnam2025 test
/benchmark install putnambench-30
/benchmark run putnambench-30 train
/benchmark run putnambench-30 test
```

`/benchmark install` prepares sources and Comparator; if the exact Mathlib is missing, select/install that version
with `/lean install` and repeat the benchmark installation. Putnam2025 has **6 train, 0 val and 6 test** tasks,
independent of the split seed; specify `train` or `test` when running it. Existing manifests with conflicting 2025
labels require an explicit update; Theoria does not silently relabel frozen tasks. Benchmark runs are still started
only after their cost/limit confirmation. These suites use
the regular `theoria` profile; the currently installed Hammer add-on supports Mathlib 4.28.0.

From Telegram: `/benchmark_list`, `/benchmark_run`, `/benchmark_status`, `/benchmark_compare`, `/benchmark_cancel`, with a confirmation
button and at most `connectors.telegram.maxBenchmarkCostUsd` ($25) per run; one at a time; each trial and the result
arrive as messages; a run the bot left when it stopped is offered to resume. `/runs`, `/attack_new <objective>`,
`/attack_fork`, `/attack_resume`, `/attack_pause`, `/attack_complete` work on the selected project.

### Compression benchmarks and skill autoresearch

For repeated compression work, use `skip-verification=true` to reuse matching original-baseline measurements:

```text
/compress Solution.lean 2 skip-verification=true
/benchmark run formalqualbench train mode=compress corpus=corpus.json skip-verification=true
/autoresearch start formalqualbench corpus=corpus.json skip-verification=true
```

This is opt-in (`false` or omission verifies originals normally). A cache hit skips original Lean inspection
and profiling; compression benchmarks also skip the original Comparator check. On a cache miss, the original
still needs one Lean measurement/inspection pass for the heartbeat denominator and preservation snapshot.
Every candidate still receives Lean checks and measurements. Benchmark candidates must pass Comparator;
standalone `/compress` candidates must pass semantic preservation and axiom checks.

Compressed baseline caches live under `.theoria/compression-baselines/` (`workflows.baselineCacheDir`) and include exact
source, target, policy, environment and implementation identities. Local projects also fingerprint their Lean
sources and Lake configuration; benchmark runs use their pinned environment identity. Verified standalone candidates
seed the cache for later `/compress` calls. The flag is frozen into benchmark/campaign inputs and inherited
by autoresearch evaluations, so repeated experiments reuse the first baseline measurement. Reports record
whether verification was skipped and whether a cache was reused. Remove the cache directory to force fresh
measurements, or run with `skip-verification=false`.

Compression mode evaluates **existing verified proofs**, rather than solving the dataset's open challenges.
Import a proof corpus from manual `<task>/Solution.lean` folders or successful benchmark trial folders:

```text
/benchmark corpus import formalqualbench .theoria/benchmarks/run-005 corpus.json
```

The generated manifest lists paths only; no source proof is edited. Its task IDs define the experiment corpus.
An explicit manifest has the shape:

```json
{"schemaVersion":1,"benchmarkId":"formalqualbench","tasks":{"BanachStoneTheorem":{"file":"proofs/BanachStone.lean"}}}
```

The optional corpus `lean` field is an exact `LeanSpec` for ported proofs; otherwise the dataset environment is
used. Incompatible or incomplete baselines stop preparation instead of becoming model failures. Candidates are
measured by Lean and judged by Comparator against the frozen challenge before scoring. Comparator checks the
target statements, their dependencies, permitted axioms and kernel validity. Compression benchmarks do not
require unchanged unrelated definitions or identical compiler-generated helper declarations.

Standalone `/compress` preserves the source file's declared theorems, definitions and section context. Its
kernel-expression comparisons ignore term-binder names, and proof-generated helpers such as `.match_*`
may change or disappear when a proof is refactored. Explicitly declared helpers, including private ones,
remain protected. Scoring, heartbeat-regression limits and the accounting of new or rewritten helpers apply in
both modes. Reports identify the candidate verification mode as `preservation` or `comparator`.

Run a single skill evaluation (the original `/benchmark run` remains proving mode):

```text
/benchmark run formalqualbench train mode=compress corpus=corpus.json skill=skills/compress-v1.md rounds=2 repeat=1 concurrency=2 cost=3
```

Both `/compress` and `/benchmark run ... mode=compress` support the same skill selection:

| Selection | Additional compression skill |
|---|---|
| Omit `skill` | Bundled `packages/theoria-workflows/skills/compress/SKILL.md` |
| `skill=<path>` | The specified file, relative to the command's working directory or absolute |
| `skill=none` | No additional skill body; the core compression prompt, scoring, verification and retries remain active |

```text
/compress Solution.lean 2
/compress Solution.lean MyNamespace.myTheorem 2 "skill=skills/my strategy.md"
/compress Solution.lean 2 skill=none
/benchmark run formalqualbench train mode=compress corpus=corpus.json rounds=2
/benchmark run formalqualbench train mode=compress corpus=corpus.json skill=none rounds=2
```

Quote the whole `skill=<path>` argument when it contains spaces. Empty skill files are rejected; use
`skill=none` explicitly for a core-prompt-only baseline. Selection (`default`, `file`, or `none`), resolved
path when applicable, skill text and its hash are recorded in compression reports and frozen benchmark inputs.
Later file edits do not affect a running evaluation or its retries. Historical inputs without selection
metadata still use their saved skill text, not the current default.

For a subset corpus, specify the matching task IDs in `/benchmark run`; a missing selected baseline is an error.
Inputs, skill text, prompt, environment, code fingerprint, and score policy are frozen per run. Workers start from
identical proof copies. Candidate/checkpoint reports and transcripts are kept under the benchmark run's trials.
Compression status reports improved/no-improvement and mean `compress_score`; comparison allows differing skills
only when the remaining experimental settings and baselines match. Interrupted attempts retain their traces.

To revise a skill iteratively, with held-out selection, use `/autoresearch` (below). Candidate skill files are
local inputs; they are not shipped with Theoria.

Revision workers use a stricter macOS read allowlist than ordinary benchmark workers: only their workspace,
runtime code/dependencies, and required Lean libraries. Sibling trials, corpus manifests, controller state and
held-out evidence are not readable. Isolated Git dependency probes ignore global/system configuration and can
use `/dev/null`, so a blocked global config read is not mistaken for a changed package URL. Shared dependencies
remain read-only. Deployment of a winning skill remains a reviewed PR; nothing rewrites the bundled skill.

### Unattended campaigns: `/autoresearch`

The base agent can supervise a sequence of compression experiments: inspect results and trajectories,
search arXiv, stage a revised skill, compare models or independent repeats, and launch the next batch.
The existing benchmark workers still perform each proof attempt; they cannot start campaigns themselves.

```text
/autoresearch start putnam2025 corpus=.theoria/putnam2025-run-007.corpus.json skill=/path/to/candidate.md budget=100 minutes=180 workers=6
/autoresearch start <benchmark> objective="Compress .lean proofs according to compress_score" skill=/path/to/v10.md,/path/to/v9-mcts.md
/autoresearch status campaign-001
/autoresearch pause campaign-001
/autoresearch resume campaign-001
/autoresearch cancel campaign-001
```

Only the benchmark is required when it supplies a default proof corpus; otherwise provide `corpus=<manifest>`.
`objective="..."` supplies the research goal. `skill=/path/a.md,/path/b.md` snapshots explicit starting skills
in order as `v001`, `v002`, etc.; the first is the comparison reference. Omit `skill` for the bundled default,
or use `skill=none` on its own. Quote the whole argument when paths contain spaces. Duplicate paths or identical
skill contents are rejected; source files can change afterwards without changing the campaign.

The initial confirmation authorizes the campaign's scope. Omitted `budget`, `minutes`, `cost`, `timeout`,
`turns`, `experiments`, and `decisions` mean **unlimited**, including on resume. The preview explicitly states
when there is no spending or time limit. Positive numeric values set caps: `cost` is per trial, while `budget`
includes trials and supervisor responses. A finite campaign budget also bounds otherwise-unlimited jobs;
available funding is divided among those jobs in a submitted batch. Explicit timeouts retain the configured
benchmark timeout range. Parent research turns retain their configured caps ($3 / 40 responses by default).

Optional `models=provider/id,provider/id` permits a specific model set; the default is the current model.
Workers default to six (bounded by the configured concurrency maximum), harness to the current profile,
thinking to the benchmark default, and development to `train,val`. Models must exist in the session's registry.
Ordinary `/benchmark run` keeps its existing finite defaults.

During research turns, the base agent uses the dedicated `autoresearch` tool to stage skills, submit batches,
read evidence, retrieve arXiv abstracts/HTML, and finish. The host reserves spending and shares worker slots
across the campaign's runs. It returns batch results automatically; the agent does not need to poll.
The workflow lives in `packages/theoria-autoresearch`, with its default methodology at
`packages/theoria-autoresearch/prompts/default.md`, frozen at campaign creation. It requires one changed
factor per experiment, matched controls, and evidence-driven skill changes.

`read_evidence` supplies compact summaries and selected, clipped trajectory excerpts. For an unexplained
regression or preservation failure, the supervisor can inspect raw artifacts through the same tool:
`read_trajectory(job_id, task_id, attempt, cursor)` reads recorded session JSONL, and
`read_candidate(job_id, task_id, round, attempt, cursor)` reads a candidate proof (`round=0, attempt=0`
selects the baseline). `attempt` means a worker attempt for trajectories and a candidate attempt for proofs;
optional `replicate` selects a trial repetition, defaulting to 1. Start at byte `cursor=0` and follow
`nextCursor`; pages use `autoresearch.artifactPageBytes` (frozen per campaign, reported as `pageBytes`)
and can split JSON records. Older campaigns use the configured default. Set this to an integer of at
least four bytes to fit a UTF-8 character. The host resolves paths
from the campaign's authorized development jobs, refuses symlink escapes and active attempt reads, and
includes recorded acceptance status with candidate source. Full traces are read on demand, not injected
into every research turn.

The `autoresearch` harness component loads this supervisor independently of the `bench` component, which
provides `/benchmark`. Full Theoria profiles enable both. Custom profiles that previously used `bench` for
both commands should add `autoresearch` explicitly. The supervisor calls the public
`@theoria/pi-bench/backend` execution/measurement API; it does not need the benchmark command extension.
Campaign APIs are exported from `@theoria/pi-autoresearch/api`.

Campaign defaults now live under top-level `autoresearch` in `theoria.config.json`. Existing
`benchmarks.campaigns` overrides are still accepted, with explicit `autoresearch` values taking precedence.
`benchmarks.autoresearch` (the settings of the removed `/benchmark improve`) is ignored if a user file still has it.

Keep Theoria open. Pause stops new dispatches and lets in-flight experiments finish; cancel interrupts them.
Esc or session shutdown interrupts work and saves a resumable checkpoint. Resume reconciles existing runs and
refuses to duplicate live workers. The campaign keeps the same parent model, corpus, limits and execution code.
Each parent turn also has a response and spending limit; an empty or failed research turn pauses the campaign.

Records are stored under `.theoria/autoresearch/campaign-NNN/`: immutable manifest/methodology, journal,
versioned `skills/vNNN.md`, literature, development evidence and final `report.json`. Experiments retain normal
`run-NNN` records. Generated skills stay outside `packages/` so they do not change running code fingerprints.
They are not automatically promoted into the bundled skill.

Results report per-task means, sample standard deviations and best-of-k separately. Final selection checks
matched complete validation evaluations (training when no validation exists), equally weighting the authorized
models and tasks. A selected skill without that evidence is labeled provisional, not a measured improvement.
Test-split tasks are not exposed to the research loop. arXiv retrieval is bounded, records source identities,
and labels truncated text; PDF extraction and other literature providers are not included yet.

### Benchmark temporary files

Managed Lean/Lake commands get a fresh, invocation-local `TMPDIR`, removed after the process exits on
success, failure, timeout, or cancellation. In isolated workers it stays inside the existing sandbox's
scratch directory. Parallel checks never sweep one another's temporary files.

When a benchmark reaches `completed` or `cancelled`, Theoria also reclaims leftover generated Lean/Lake
metadata from its `.tmp` directories after its workers have stopped. Cleanup only removes regular `tmp.*` files with the Lean/Lake import-metadata header, or empty `tmp.*`
files. It skips nonterminal runs, live runners/workers, explicitly excluded runs, and symlinks. Proof
drafts (including `.tmp/*.lean`), logs, snapshots, manifests, inputs, and shared dependencies are preserved.
It does not remove `.lake/build` caches or change any recorded experiment result.

## Amazon Bedrock

Pi has Bedrock built in as `amazon-bedrock` (`theoria --list-models bedrock`) and reads the standard AWS
credential chain (`AWS_PROFILE`, access keys, `AWS_BEARER_TOKEN_BEDROCK`, container or IRSA credentials). With any
of `bedrock.credentialEnv` set, `theoria` starts on `bedrock.defaultModel`. An explicit `--model`, or a model chosen
with `/model` (saved in settings), always wins. Pi needs `AWS_REGION`; when it is unset, Theoria takes it from
`bedrock.region` or the profile's `region`.

## Goals: `/goal`, `/sisyphus` (pi-goal-x)

Each project can have several open goals, from the bundled [pi-goal-x](https://pi.dev/packages/pi-goal-x) package.
`/goal <idea>` plans one with the agent; `/goal-direct <objective>` starts at once; `/sisyphus` is an ordered,
step-by-step goal. The agent then works on the focused goal on its own, through its tasks, until it is done, blocked
or paused; an optional model auditor reviews the result. `/goal-list`, `/goal-focus`, `/goal-status`, `/goal-pause`,
`/goal-resume`, `/goal-tweak`, `/goal-clear`; `/goal-settings` for the auditor and limits. Goals live in the
project's `.pi/goals/`.

A goal marked complete is the agent's and the auditor's judgement. Lean's own measure is separate: in a mathematics
project `/project status` (and the bot's `/status`) shows the theorems Lean checked and the Lean target's progress
bar (verified lemmas), next to the goals.

## Telegram: `/connect-bot`, `theoria bot`

`/connect-bot` sets up a private bot: a QR code opens BotFather to create it, you paste its token (kept in the macOS
Keychain), and a second QR code pairs your phone, once, within 10 minutes. `theoria bot start|stop|restart|status|log`
runs it; `theoria bot login on` starts it at login. Only the paired account is answered.

From the phone: `/new_project`, `/projects`, `/use`, `/status [all|refresh]`, `/cancel`, `/help`, the selected
project's workflows (`/prove`, …) and goals (`/goal`, `/goal_list`, …), and plain text for its agent. Questions come
as buttons; verdicts and goal audits arrive as notifications, from terminal sessions too. `/status` is the same
summary as `/project status`; `/projects` and `/status all` use the same rows as `/project list`.

**Sandbox.** Each project the bot opens runs in its own macOS sandbox (`sandbox` in the configuration):

- writes only to that project (and the temporary directory); reads of the home folder are refused except the
  projects folder, Theoria, the Lean toolchains and Mathlib;
- Pi runs with a directory of its own and an empty credential store, so no key or OAuth token from the terminal's
  `auth.json` is inside; whatever it writes there is reset before the next session;
- the agent's commands run with every API key and token variable removed (`sandbox.secretEnvPattern`);
- of the MCP servers, only Mathlib search comes along (on or off as in the terminal); it may write only its cache;
- the project's `.pi/mcp.json`, `.pi/settings.json`, `.pi/extensions`, … (`sandbox.protectedProjectFiles`) cannot be
  written, nor the `.pi` folder replaced: Pi trusts a project by folder, so a session could otherwise leave code that
  a terminal session, outside the sandbox, would run;
- `~/.aws`, the Keychain and the bot's own state are unreadable.

**Model credentials for bot sessions.**

| Provider | How |
|---|---|
| Bedrock | set `bedrock.awsProfile` (SSO, `credential_process`, or login). The bot signs in outside the sandbox and gives sessions only short-lived keys over 127.0.0.1, with a per-run token. |
| API keys (Anthropic, OpenAI, …) | `theoria bot secret set ANTHROPIC_API_KEY` (asks for the value, stores it in the Keychain); `theoria bot secret list`, `unset`. |
| `/login` OAuth (Claude Pro, ChatGPT, Copilot) | not available to bot sessions by design: the tokens are refreshable account credentials. Use an API key or Bedrock. |

## Lean: `/lean`

`/lean` opens a menu: `config`, `install`, `status`, `remove`, `search`, `extras`. You choose a Mathlib version (its Lean follows) or a
Lean version alone; paths are never asked for. Installed toolchains and built Mathlib checkouts are found
automatically (Theoria's own installs, and checkouts up to `lean.discovery.homeScanDepth` folders below home).

- The choice is saved per project in `.theoria/lean.json`, with a global default in `~/.theoria-cli/agent/lean.json`.
  A folder that is a Lean project of its own (`lean-toolchain` and a lakefile) keeps its own setup.
- It reaches the agent's instructions, the agent's shell (`ELAN_TOOLCHAIN` and `LEAN_PATH`, so a plain `lean` works;
  Pi's `bash` tool itself is unchanged), the `lean_check` tool (errors, `sorry`, axioms) and the footer.
- `install` clones a Mathlib release, runs `lake exe cache get`, then `lake build` for anything the cache missed
  (normally nothing), in the background. About 7 GB each.
- `search` installs, removes or shows Mathlib search (above).
- `extras` installs and activates Lean add-ons (below); `/lean config` also offers installed Mathlib + add-on pairs.

### LeanHammer: `/lean extras`

[LeanHammer](https://github.com/JOSHCLUNE/LeanHammer) is built once for an exact Mathlib version, then enabled per
project. The tested configuration is **Lean/Mathlib/Hammer v4.28.0**:

```text
/lean config                 # choose Mathlib v4.28.0 for this project
/lean extras install hammer  # build once in the background
/lean extras on hammer       # enable for this project
/lean extras status
```

The project selection becomes `{"mathlib":"v4.28.0","extras":["hammer"]}` in `.theoria/lean.json`.
`/lean extras off hammer` disables it for this project; `/lean extras remove hammer` deletes the shared installation
for the selected Mathlib version. A `theoria-hammer` session requires it through its profile; choose the regular
`theoria` profile to disable that requirement.

- The shared Lake workspace lives in `~/.theoria-cli/agent/lean-envs/hammer-v4.28.0` (`lean.extrasDir`). An APFS
  copy-on-write clone reuses the existing Mathlib build; Hammer and its additional dependencies take extra disk space.
  Installation preserves Mathlib's commit and shared dependency pins, builds Hammer, warms native imports for
  read-only sandbox use, and checks the bundled Zipperposition executable.
- Activation reaches the shell, `lean_check`, workflows, Mathlib search, the Lean instructions and the footer.
  Zipperposition is linked into the working directory's gitignored `.lake/build` when needed.
- Existing **Lake projects own their dependencies**. Add `Hammer` before `mathlib` in their lakefile, pin matching
  releases, and run `lake update Hammer` and `lake build Hammer`. Theoria detects Hammer in the manifest.
- Other versions are unavailable until explicitly supported in `lean.extras[].versions`. There is no fallback to a
  different Mathlib. Hammer v4.33.0 uses a different solver stack and is not integrated yet; no v4.33.1 tag exists.

For example:

```lean
import Hammer
import Mathlib.Data.Nat.Basic

example (a b : Nat) (h : a ≤ b) : a < b + 1 := by
  hammer [Nat.lt_add_one_iff] {aesopPremises := 0, autoPremises := 0}
```

The zero premise counts make this example offline. With premise search enabled, Hammer sends queries to
`leanpremise.net`. Upstream asks heavy benchmark users to self-host; the service can be changed with Lean's
`premiseSelection.apiBaseUrl` option. Replace a successful `hammer` call with its suggested tactic script (retaining
needed tactic imports), then recheck it. This lets Comparator verify the reconstructed proof without network access.
Options vary by Hammer release; v4.28.0 does not accept the newer `parallelism` or `disableDuper` options.

**Benchmarks:** `theoria-hammer` supplies the same pinned workspace to trials and fresh Comparator evaluations,
checking the benchmark's exact Mathlib, Lean and shared dependency revisions before running, including on resume.
For FormalQualBench, choose tasks in your installed train split:

```text
/benchmark run formalqualbench train 2 harness=theoria-hammer
```

The core-only `smoke` suite and PutnamBench's v4.33.1 setup are incompatible with this profile. Use `theoria` for
those. Hammer finds candidate proofs; Lean and Comparator still decide acceptance.

## Workflows: `/formalize`, `/prove`, `/compress`

Each accepts a `.lean` file, a theorem name, or free text (`/formalize Legendre conjecture`, `/prove the sum of the
first n odd numbers is n squared`). The agent works from a Markdown prompt; Theoria then runs its own check, which
the prompt cannot change, and retries with Lean's messages until a check passes or the attempts run out.

| Command | Theoria accepts it when |
|---|---|
| `/formalize` | the new theorem elaborates with `sorry` as its only gap. Several readings: you pick one. Well-formed, not true. |
| `/prove` | Lean verifies it with the statement unchanged, no new axioms or changed definitions, and only `workflows.standardAxioms`. From free text it formalizes first, and you confirm the statement. |
| `/compress` | all assigned proofs verify under unchanged statements and improve the configured token/heartbeat/compatibility score. The best verified checkpoint is retained. |

A failed or cancelled `/prove` or `/formalize` run restores the original and keeps the attempt under
`.theoria/attempts/`. Compression restores the best verified result reached so far.

`/compress Solution.lean` targets **the entire file**: one workflow reviews all theorem and lemma proofs, without
a theorem chooser. Existing theorem/lemma names, statements and definitions are preserved; helper lemmas are
shortened rather than deleted. New helpers count toward size and are checked too. To target one proof, use
`/compress Solution.lean Namespace.myLemma` or `/compress Namespace.myLemma`. An individual target can coexist
with pre-existing gaps elsewhere; compression still preserves the other statements and prevents new gaps from
being used to manufacture a size reduction.

The optional final argument is a **positive integer number of optimization rounds**, default **1**:

```text
/compress Solution.lean
/compress Solution.lean 5
/compress Solution.lean Namespace.myLemma
/compress Solution.lean Namespace.myLemma 5
```

Each round re-reads and replans from the best verified checkpoint. `max-attempts` bounds repair attempts within
a round. Accepted improvements advance to the next round; unchanged drafts, negligible gains or exhausted repairs
stop early. Cancellation and provider failures preserve both the best proof and the unfinished draft.

Compression checks a Lean-generated snapshot of declaration types and axioms, including private helpers, section
parameters and universes. Anonymous examples are named only in the verification copy so their statements and axioms
can be checked; source layouts the scanner cannot cover are reported as unsupported. Core-only files are also
checked before adding the inspector's Lean import. Checks share the configured timeout.

Verdict cards, agent-facing results and history include measured size before/after, lines saved and percentage
reduction, for example: **201 → 110 significant LOC · 91 lines saved · 45.3% reduction**. The metric excludes
imports, comments and section bookkeeping; it includes all helper proofs, even for an individual-theorem target.
Reports also include before/after heartbeats and heartbeat reduction, requested/completed/improved rounds,
target scope/names, versions actually checked, imports, per-declaration metrics where practical, and check duration.

Every submitted candidate and round gets a progress card with a combined score, relative to the **original** baseline:

```text
compress_score = w_tokens × proof-token reduction % + w_heartbeats × heartbeat reduction %
               + w_compatibility × measured compatibility % + w_loc × LOC reduction %
default: (token reduction % + heartbeat reduction % + compatibility %) / 3
```

Proof tokens count bodies after `:=`, excluding statements, comments and blank lines. Helpers are included;
new non-proof helper declarations count in full to prevent free extraction. The default tokenizer is pinned
`js-tiktoken` with `cl100k_base`; `o200k_base` is also supported. **The Arena's exact tokenizer is not public:
these counts are reproducible local measurements, not a claim of exact leaderboard parity.**

Scores use unrounded reductions and allow negative gains. Compatibility is an absolute pass percentage, not
a reduction: a fully compatible unchanged baseline scores 33.33 with the defaults. Unverified or unmeasured
candidates are unscored (`n/a`). The Pareto frontier uses only positive-weight axes; the configured score ranks
those tradeoffs. Reports include token counts, tokenizer, version denominator, per-axis contributions and weights.
Progress cards are separate from the final verification verdict. The report and candidate/checkpoint sources live
under `.theoria/attempts/<file>-compression-*/`; history records their paths, candidate scores and round summaries.

Configure weights in `theoria.config.json` or the user override (`~/.theoria-cli/config.json`), for example:

```json
{
  "workflows": {
    "compression": {
      "rounds": 1,
      "scoreWeights": { "tokens": 0.3333333333333333, "heartbeats": 0.3333333333333333, "compatibility": 0.3333333333333333 },
      "tokenizer": "cl100k_base",
      "compatibilityProjects": []
    }
  }
}
```

Weights must be nonnegative and sum to one, and are captured with the baseline for the entire workflow.
An explicit `scoreWeights` object replaces all weights; omitted weights become zero. The legacy
`{ "loc": 0.7, "heartbeats": 0.3 }` remains supported. Setting tokens, heartbeats and compatibility to
`0.3333333333333333` each is the default and matches the Arena's equal-axis weighting.
Frozen legacy policies retain their two-axis scores.
`workflows.compression.minImprovementPercent` defaults to a 0.1 percentage-point score gain;
`maxHeartbeatRegressionPercent` defaults to a 10% cap relative to both the original and current best.
`--emphasis` guides the editing strategy without overriding score weights. A worthwhile heartbeat-only improvement
can pass even when LOC is unchanged; tradeoffs may pass when they improve the score and satisfy the regression guard.

Heartbeats come from Lean's **serial command-elaboration profiler**, not wall-clock estimates. Theoria converts
1000 internal ticks to one user-facing heartbeat and accounts for outermost command ranges, avoiding duplicate
counts from macro expansion (such as `lemma` → `theorem`). Imports/startup and the verification inspector are
excluded. A command covering multiple declarations is marked shared in per-declaration metrics. File-level totals
include helpers even for single-theorem targets. The model can request the same measurements with
`lean_check` using `measureHeartbeats: true`; `lean.check.maxHeartbeatCommands` bounds the displayed command list.
Compatibility is the fraction of the fixed matrix that passes unchanged. By default the matrix is just the
primary environment. To check additional versions, put paths to **already prepared Lake project roots** in
`compatibilityProjects` (absolute, `~`, or relative to the workflow's working directory). Each must provide
the imports and toolchain the proof needs. The same source is checked in each project without editing its
files; compile failures remain in the denominator. Unavailable/timed-out checks stop the workflow rather than
fabricating a compatibility score. Existing verification sandboxes remain in effect, so snapshots used in
sandboxed benchmarks must already be usable under that sandbox. This does not install or port projects, or
implement the Arena's repository-specific in-place substitution. An untested matrix earns no compatibility credit.

Lean workflows hold a macOS idle-sleep assertion (`workflows.awake.preventSleep`). Press Esc in the TUI or run
`/workflow-cancel` to stop a workflow, including an in-flight Lean check. Provider failures and unavailable/timed-out
checks stop the workflow and preserve its draft; an interrupted agent-initiated workflow waits for an explicit retry.

Theorem lookup tracks namespaces and sections. Use a fully qualified name such as
`/compress formal/Proof.lean BanachStoneTheorem.MainTheorem`, or the unique short name
`/compress formal/Proof.lean MainTheorem`. Ambiguous short names require a choice; verification always uses the
resolved full name. Compression preserves that name and runs against the selected Lean/Mathlib environment.

### Compression skill and intent routing

The active skill is `packages/theoria-workflows/skills/compress/SKILL.md`; it is the only compression skill
shipped. Experimental candidates are not part of the repository or releases. Keep them anywhere (a git-ignored
`packages/theoria-workflows/skills/compress/_staged/` folder works locally) and select them explicitly using
`skill=<file>` or `candidate=<file>` in benchmark commands. They are not automatically loaded alongside the active skill.

The bundled [`compress` skill](packages/theoria-workflows/skills/compress/SKILL.md) guides proof shortening:
theorem reuse → structural refactoring → normalization → narrow deterministic tactics → reconstructed search
(including LeanHammer when available) → minimization. Readability, stable APIs and elaboration cost guide candidate
selection; each accepted change must verify with Lean.

When a user asks to **shorten a Lean proof, reduce its size, or lower its heartbeat cost**, the agent's command-tool
guidelines direct it to invoke the `compress` workflow through the `theoria` tool. For a whole-file request the call
is `{"action":"compress","args":"Solution.lean 5"}` for up to five rounds; omitting the count uses one round.
For a specific declaration, use `"Solution.lean Namespace.myLemma 5"` as `args`.
Inside an active compression workflow it applies the skill directly, without recursively starting another workflow.

Pi discovers the skill as `/skill:compress` in sessions where `/compress` is enabled. The checked workflow injects
the skill body into every attempt, including retries and project/user-overridden command prompts. Theoria still
requires the original to verify, preserves statements and definitions, and keeps measured improvements in the
configured objective. The agent reports before/after metrics, rounds, compatibility and concise transformations.

**Customizing.** Prompts are looked up in `.theoria/commands/<name>.md`, then `~/.theoria-cli/agent/commands/<name>.md`,
then the default in `packages/theoria-workflows/commands/`. To customize one, copy the default into
`.theoria/commands/` and edit it. The body takes `$ARGUMENTS`, `$1`, `{{request}}`,
`{{file}}`, `{{theorem}}`, `{{statement}}`, `{{lean}}`, `{{diagnostics}}`, `{{attempt}}`, and `{{#if x}}…{{/if}}`;
compression also provides `{{whole_file}}`, `{{target_count}}`, `{{theorems}}`, `{{theorems_json}}`,
`{{baseline_lines}}`, `{{baseline_heartbeats}}`, `{{round}}`, `{{rounds}}`, `{{current_lines}}`,
`{{current_heartbeats}}`, `{{current_score}}`, `{{score_weights}}`, `{{current_measurements}}` and `{{best_snapshot}}`
(`theorem`/`statement` are empty in whole-file mode). Text after `<!-- on-retry -->` is sent
after a failed check. The scope contract and compression skill are injected into custom prompts and retries.
Frontmatter settings, each validated:

| Setting | Default | |
|---|---|---|
| `description`, `argument-hint` | | shown in command completion |
| `max-attempts` | `workflows.defaults.maxAttempts` | within `workflows.limits.maxAttempts`; repair attempts per compression round |
| `timeout-seconds` | `workflows.defaults.timeoutSeconds` | per Lean check |
| `model` | the session's | `provider/model-id` for this command |
| `allowed-axioms` | none | extra axioms to permit; can only add |
| `emphasis` | `balanced` | `/compress`: `loc`, `clarity` or `balanced` |
| `confirm-statement` | `true` | `/prove`: confirm a statement found from free text |

## Project paper: `/latex`

One paper per project, with four commands:

| Command | |
|---|---|
| `/latex paper create [brief]` | Create an evidence-based draft from project notes, claims, results and figures; compile it and repair within the configured limits. |
| `/latex paper update [request]` | Revise the existing paper using a request or new project evidence, preserving a source snapshot first. |
| `/latex pdf` | Compile and open the resulting PDF in the terminal's desktop viewer. RPC/bot sessions return its path. |
| `/latex status` | Paper location, TeX tools, latest build, warnings and whether the PDF is current. Its menu offers dependency setup, compiler settings and the build log. |

`/latex` opens the same four choices. `Esc` stops an active terminal operation; the status menu also offers a stop
action. The `latex` harness component and `projectTypes.<type>.latex` control availability independently of Lean.
Paper writing is also available to the model through the `theoria` tool's `latex-create`/`latex-update` deferred
actions; `latex-pdf` and `latex-status` return compiler results inline. The existing action policies apply.

### Files and evidence

The default `paper/` directory is **in the current project's root**, alongside `formal/`, notes and results:

```text
paper/
  main.tex
  sections/
  references.bib
  figures/
  tables/
  outline.md
.theoria/latex.json
.theoria/latex/
  state.json
  builds/<build-id>/
  attempts/<attempt-id>/
```

The directory is created on `/latex paper create`, which refuses to overwrite an existing paper. Creation drafts
an outline with links to project evidence, writes sections and checks the result. Update reads the current paper
and makes targeted changes; its `before/` snapshot preserves the previous sources. Failed or cancelled attempts
leave the editable draft in place and retain the last successful PDF. Resume writing with `paper update`.

Automatic paper writing requires a named Theoria project. Select it with `/project list` first; `/latex status`
shows its name and absolute root. Starting `theoria` in the CLI repository does not select a nested research project.
For Birkhoff, both the paper and its `.theoria/latex/` records belong under
`theoria-projects/birkhoff-conjecture/`.

Each project's `.theoria/` is local to that project: research runs, claims, artifacts, benchmark runs and paper
builds are resolved from its root. Evidence collection stops at nested project boundaries, and run bindings carry
the owning project path as well as the local run number. There is no automatic cross-project context merge.
Terminal file tools can explicitly read other folders when requested; shared tool installations and user-level
configuration live in `~/.theoria-cli/agent/` and `~/.theoria-cli/config.json`.

The workflow gathers bounded excerpts from project files plus research claims and artifacts, labels stale claim
verification, and records an evidence snapshot with hashes. It is instructed to distinguish proofs, empirical
evidence and conjectures and to leave missing results/references explicit. Compiler success checks the document,
not the truth of its prose. Successful outputs are registered as paper artifacts, linked to the current research
run when there is one.

Prompts: `.theoria/commands/latex-create.md` / `latex-update.md`, then the same names in the agent's `commands/`,
then `packages/theoria-latex/commands/`. These are writing instructions; compiler checks and limits remain in code.

### TeX setup and builds

Theoria discovers TeX Live/BasicTeX engines on PATH and in `latex.binDirs`. On this machine it uses **BasicTeX 2026**.
If `latexmk` is missing, contextual setup installs a pinned upstream-source copy in the agent's `latex/latexmk/`
directory. Missing relocatable TeX packages are installed with `tlmgr --usermode` into `latex/texmf/`; TeX caches
live in `latex/cache/`. The package repository must match the installed TeX Live year. Engines and non-relocatable
binary packages such as Biber need installation in the selected TeX distribution; setup reports that explicitly.

The default engine is pdfLaTeX; the status menu can select XeLaTeX/LuaLaTeX and adopt an existing project-relative
entry point. Settings are saved in `.theoria/latex.json`. Every compilation has a fresh output directory, with
multi-pass compilation and bibliography processing handled by `latexmk`. Build records retain compiler versions,
logs and input hashes; changes to source, bibliography, figures or recorded dependencies mark a PDF stale. A failed
build never opens an older PDF as though it were new. Shell escape and project `latexmkrc` execution are disabled.

`latex.workflow` bounds writing attempts, elapsed time and provider-reported cost; `compileTimeoutSeconds` and
`maxPasses` bound compilation. Missing tools/packages are **unavailable**, distinct from source errors. TeX
subprocess groups are stopped on cancellation or timeout. PDF builds work inside the bot sandbox using prepared,
read-only dependencies. From Telegram, `/latex paper create`, `/latex paper update`, `/latex pdf` and `/latex status`
use the selected project; dependency installation is done in a terminal.

## Packages

| Package | |
|---|---|
| `theoria-shared` | library: validated configuration, paths, process running, project types, cards (not a Pi package) |
| `theoria-mcp` | library: Pi's MCP extension with the project-type filter, `theoria mcp-launch`, `/project servers` saving (not a Pi package) |
| `theoria-core` | `/new-project`, `/project`, the actions hub (the `theoria` tool) |
| `theoria-tui` | the animated header, footer with Lean and Mathlib, framed editor, telemetry, thinking peek, `/tui` |
| `theoria-lean` | `/lean`, `lean_check`, for types with `lean`; its API for other packages is `@theoria/pi-lean/api` |
| `theoria-workflows` | `/formalize`, `/prove`, `/compress`, as the project's type enables them |
| `theoria-latex` | `/latex`: one project paper, TeX dependency setup, PDF compilation, evidence-based creation and updates |
| `theoria-research` | research runs, claims (formal and statistical verification), artifacts, plans: `/attack`, `/runs`, `/claim(s)`, `/artifact(s)`, `/plan` |
| `theoria-bench` | benchmarks: splits, exact Lean environments, sandboxed trials, Comparator, `/benchmark` |
| `theoria-autoresearch` | `/autoresearch` supervisor: campaign scheduling, journals, evidence, literature and methodology |
| `theoria-telegram` | `/connect-bot`, `theoria bot`, notifications, the sandbox and credential broker for bot sessions |
| [`pi-goal-x`](https://pi.dev/packages/pi-goal-x) 0.32.3 | npm, in `launcher.piPackages`: goals |
| [`pi-better-render`](https://pi.dev/packages/pi-better-render) 0.2.0 | npm, listed in `launcher.piPackages`: rich Markdown and LaTeX rendering |

Each local package with a `pi` manifest is an ordinary Pi package, loaded with `--extension` and usable with plain
`pi -e ./packages/<name>`. Pi provides `@earendil-works/*` at runtime, so packages declare them as `peerDependencies`.
To add an npm Pi package: `npm install --save-exact <pkg>`, then add it to `launcher.piPackages`.

## Terminal interface: `/tui`

`theoria-tui` (adapted from pi-open-tui and pi-cc-header, both MIT; see its `NOTICE.md`):

- **Header** (the `welcome` component): at startup the Θ logo is sheared apart and re-assembles, as on the
  [Theoria website](https://www.theoria.sh): it holds for `tui.logo.holdMs` (400 ms), then each row is shifted
  cyclically across the logo column by `shear × row offset` while the shear runs through one full period over
  `shearMs` (2.4 s, eased), brightening as it moves, and lands exactly on the original. `tui.logo.intro: "sweep"` keeps
  the earlier gradient draw-in (`sweepFrames`); `animate: false` shows it still. Then a slow brightness pulse
  (`tui.logo.pulse`, off with `false`; `pulseMs`, `frameMs`), beside the project, model and thinking
  level, the Lean environment and Mathlib search, and the main commands (`/lean`, `/project`, `/prove`,
  `/autoresearch`, `/latex`, `/help`; `tui.logo.tips` sets how many, and a profile without a command shows the next
  one). The pulse stops when the conversation starts; nothing animates outside the terminal interface.
- **Startup listing:** Pi's list of loaded extensions, skills and context files (by file name) is hidden. Theoria
  sets Pi's `quietStartup: "header"` once in `~/.theoria-cli/agent/settings.json` when you have not chosen a value;
  warnings and conflicts still show, `theoria --verbose` shows the listing, and `/settings` changes it.
- **Footer** (the `tui` component): current project name, cwd, git state, runtime, context, tokens and cost; model and thinking level, with
  Lean and Mathlib, the research run and benchmark progress pinned beside them (`tui.pinnedStatuses`); other
  extensions' statuses below.
- The project name comes from `.theoria/project.json`, falling back to the project-root folder name, and follows
  project switches in both normal and inline footers. Toggle it in `/tui` → Footer → Project name
  (`tui.footerSegments.projectName`).
- A framed editor, per-turn telemetry (tokens per second, time to first token, stalls, cost rate), and a thinking
  peek in place of "Thinking…". Icons `auto` (Nerd Font where the terminal supports it), `nerd`, `unicode`, `ascii`.

`/tui` changes the settings (saved to your config file, under `tui`). The `bare`
and `lean` harness profiles load neither, so they look like plain Pi.

## Rendering

`pi-better-render` restyles headings, tables, code and callouts while an answer streams, and typesets LaTeX. It is
display-only. Formulas are images in Ghostty and Kitty; elsewhere (Apple Terminal, iTerm2, WezTerm, tmux) Unicode.
`/better-render status | on | off | math:off`. Its downloads go to `~/.theoria-cli/agent/better-render/`; set
`PI_BETTER_RENDER_MERMAID_INSTALL=0` to skip the 11 MB Mermaid renderer.

## License

Copyright 2026 DeepHedge Labs LLC. Theoria CLI is licensed under the [Apache License, Version 2.0](LICENSE); see
[NOTICE](NOTICE). Files adapted from third-party projects keep their original MIT licenses, listed in NOTICE and
[`packages/theoria-tui/NOTICE.md`](packages/theoria-tui/NOTICE.md).
