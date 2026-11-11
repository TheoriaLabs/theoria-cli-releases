---
description: Propose ranked next research steps for a paper, a set of papers, or a line of research
---
Expand on this paper / line of research: $ARGUMENTS

1. **Gather.** Fetch each paper: for an arXiv ID or URL use the arXiv API (https://export.arxiv.org/api/query) and the
   abstract page (https://arxiv.org/abs/<id>), and the HTML version (https://arxiv.org/html/<id>) when it exists. Read
   local files directly. For a topic in words, first find its two to five central recent papers. Then find 5–10
   closely related or citing works, the same authors' first. List everything you gathered with links. If a source
   cannot be fetched, say so and continue with the rest.
2. **Gauge momentum.** From what you gathered, note where activity is growing: recent papers (roughly the last two
   years), citing works, groups returning to the topic, and new tools that make old questions tractable. Prefer ideas
   on active fronts, and say so when an idea goes against the trend.
3. **Distill.** State the core contributions, the methods, and the open questions or limitations the authors mention
   themselves. Keep the formulas that define the setting. Keep what the authors claim separate from your own reading.
4. **Propose {{count}} extensions.** For each:
   - one-line idea, and why it is new relative to the gathered works (write "novelty not checked" when you have not
     searched enough to know);
   - type: theory, numerics, or formalization;
   - concrete first step: a computation, an experiment, a lemma, or a Lean statement;
   - difficulty (low / medium / high) and the main risk.
{{#if focus}}
   **Focus: {{focus}}.** {{focus_guidance}} Weigh research trends and recent momentum within this kind of work.
{{/if}}
5. **Rank** them and recommend the top one or two, with the reason.
6. **Offer** to record chosen ideas with `/claim new hypothesis <statement>` and, where a result can be formalized, to
   `/formalize` it; for a larger direction, `/attack new <objective>`. Do not create claims, runs or files on your own.

Be concise. Use this project's runs, claims, plan and Lean files where they are relevant. Cite only sources you
actually fetched in this session; never invent a reference, theorem number or result. Mark guesses as guesses, and
distinguish proved results, empirical evidence and conjecture.
