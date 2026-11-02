/**
 * `/help`: Theoria's slash commands, each with a one-line summary and its forms. In a form, `<value>` is required,
 * `[value]` optional, and `a|b` means one of them. The catalog lists every command a Theoria package registers (a
 * test holds it to that); `/help` shows only the commands this session actually has, so a harness profile without a
 * component does not advertise its commands.
 */

export interface HelpEntry {
  command: string;
  summary: string;
  /** Each form of the command, without the leading slash and name. Empty string: the command alone. */
  forms: string[];
  /** Further detail shown by `/help <command>`. */
  notes?: string[];
}

export interface HelpSection { title: string; entries: HelpEntry[] }

export const helpSections: HelpSection[] = [
  {
    title: 'Lean and proofs',
    entries: [
      { command: 'lean', summary: 'Choose, install and check the Lean and Mathlib this project uses.',
        forms: ['', 'config', 'status', 'install', 'remove', 'search <status|install|remove>', 'extras <status|install|on|off|remove> [hammer]'],
        notes: ['Without arguments it opens a menu. A Lean project of its own keeps its toolchain and dependencies.'] },
      { command: 'prove', summary: 'Prove a theorem; Lean decides whether the proof is complete.',
        forms: ['<file.lean> [theorem]', '<theorem name>', '<description of the result>'] },
      { command: 'formalize', summary: 'Turn an informal statement into a Lean statement (with sorry), checked by Lean.',
        forms: ['<statement | file with one> [--name <theorem_name>]'] },
      { command: 'compress', summary: 'Shorten verified proofs and lower their heartbeats, keeping every statement.',
        forms: ['<file.lean> [declaration] [rounds] [skill=<path>|none] [--emphasis loc|clarity|balanced] [skip-verification=true]',
          '<theorem name> [rounds]'] },
      { command: 'workflow-cancel', summary: 'Cancel the running /formalize, /prove or /compress, including its Lean check.', forms: [''] },
    ],
  },
  {
    title: 'Research',
    entries: [
      { command: 'autoresearch', summary: 'Unattended, bounded research campaigns that improve a benchmark result.',
        forms: ['start <benchmark> [objective="…"] [corpus=<manifest>] [skill=<path>,…|none] [budget=<USD>] [minutes=<n>] [workers=<n>] [models=…]',
          'status [campaign-id]', 'pause [campaign-id]', 'resume [campaign-id]', 'cancel [campaign-id]'],
        notes: ['Omitted limits are unlimited; the start confirmation shows what is authorized. Without an id, the latest campaign.',
          'More limits: experiments=, decisions=, cost=, timeout=, turns=, skip-verification=true.'] },
      { command: 'next-steps', summary: 'Suggest ranked next research steps for papers or a line of research.',
        forms: ['<arxiv-id | url | file | topic> [more papers…] [--n <1-10>] [--focus theory|numerics|formalization]'],
        notes: ['Examples: `/next-steps 2401.01234`, `/next-steps paper.pdf 2312.04567 --n 5`, `/next-steps "sphere packing in dimension 8" --focus formalization`.',
          '`--n` sets how many ideas (default 5–8); `--focus` biases them toward theory, numerics or Lean formalization, weighing recent momentum in that kind of work.',
          'The agent reads the sources, then answers in the conversation; nothing is recorded unless you ask.',
          'Edit the prompt by copying `packages/theoria-research/prompts/next-steps.md` to `.theoria/commands/next-steps.md`.'] },
      { command: 'run', summary: 'Research runs: a bounded effort with a persistent goal.',
        forms: ['status', 'new <objective>', 'fork [objective]', 'resume [run-id]', 'pause', 'complete', 'update focus <text> | note <text> | ready [summary]'] },
      { command: 'runs', summary: "The project's research runs, with their forks.", forms: [''] },
      { command: 'plan', summary: 'The proof or research plan of this run (or project).', forms: ['[show]', 'check'],
        notes: ['check asks Lean whether the plan is a valid proof skeleton.'] },
      { command: 'claims', summary: "The project's claims, optionally by status.", forms: ['[hypothesis|supported|verified|refuted|stale]'] },
      { command: 'claim', summary: 'One claim: create, change, link evidence, verify.',
        forms: ['<id>', 'new [hypothesis|supported] <statement>', 'set <id> <hypothesis|supported|refuted> [why]', 'edit <id> <statement>',
          'link <id> <supports|refutes|verifies|derived-from> <artifact|path>[:<theorem>]', 'verify <id>', 'test <id> <data> <test>'],
        notes: ['A claim is verified only by Theoria: formally by Lean, or statistically from a linked data file.'] },
      { command: 'artifacts', summary: "The project's artifacts.", forms: [''] },
      { command: 'artifact', summary: 'Record or show an artifact.', forms: ['<id>', 'add <path> [kind] [description]'] },
      { command: 'latex', summary: "The project's paper: create, update, compile.",
        forms: ['', 'status', 'pdf', 'paper create [brief]', 'paper update [request]'], notes: ['Without arguments it opens a menu.'] },
      { command: 'subagent', summary: 'Independent child tasks with their own limits.',
        forms: ['start <task>', 'list', 'status <id>', 'result <id>', 'wait <id>', 'cancel <id>'] },
    ],
  },
  {
    title: 'Benchmarks',
    entries: [
      { command: 'benchmark', summary: 'Install benchmark suites, run trials judged by Comparator, compare runs.',
        forms: ['list', 'install <id>', 'run <id> [train|val|test] [N | task,task] [cost=<USD>] [repeat=<k>] [concurrency=<c>] [timeout=<min>]',
          'run <id> mode=compress [corpus=<manifest>] [skill=<path>|none] [rounds=<n>]', 'status [run]', 'compare <run> <run>', 'resume [run]', 'cancel [run]'],
        notes: ['A run costs money and asks first; the test split asks again.'] },
    ],
  },
  {
    title: 'Project and interface',
    entries: [
      { command: 'project', summary: 'Projects: list and switch, status, type, MCP servers.',
        forms: ['', 'list', 'status [refresh]', 'type [type]', 'new [name]', 'servers'], notes: ['Without arguments it opens a menu.'] },
      { command: 'new-project', summary: 'Create a Theoria project and choose its type.', forms: ['[name]'] },
      { command: 'connect-bot', summary: 'Connect Theoria to Telegram: pair your phone by QR code.', forms: ['', 'status', 'pair', 'remove'] },
      { command: 'tui', summary: 'Interface settings: footer, editor, telemetry, thinking peek, icons.', forms: [''] },
      { command: 'help', summary: 'This list, or one command in detail.', forms: ['[command]'] },
    ],
  },
];

/** Registered by Theoria for its own use, not typed by a person. */
export const internalCommands = ['theoria-queue'];

const entries = () => helpSections.flatMap(section => section.entries);

export const helpLegend = 'Syntax: `<value>` required · `[value]` optional · `a|b` one of them.';

const form = (entry: HelpEntry, text: string) => `\`/${entry.command}${text ? ` ${text}` : ''}\``;

/**
 * The help text, as Markdown. `available` holds the command names this session has (with their descriptions, for
 * commands outside the catalog); `topic` asks for one command.
 */
export function helpText(available: { name: string; description?: string }[], topic = ''): { title: string; lines: string[]; ok: boolean } {
  const names = new Set(available.map(command => command.name));
  const wanted = topic.trim().replace(/^\//, '');
  if (wanted) {
    const entry = entries().find(item => item.command === wanted);
    const other = available.find(command => command.name === wanted);
    if (entry && names.has(entry.command)) {
      return { title: `/${entry.command}`, ok: true, lines: [entry.summary, '', ...entry.forms.map(text => `- ${form(entry, text)}`),
        ...(entry.notes?.length ? ['', ...entry.notes] : []), '', helpLegend] };
    }
    if (other) return { title: `/${other.name}`, ok: true, lines: [other.description || 'No description.'] };
    return { title: `/help ${wanted}`, ok: false, lines: [`No command /${wanted} in this session. \`/help\` lists the available ones.`] };
  }
  const lines: string[] = [];
  for (const section of helpSections) {
    const present = section.entries.filter(entry => names.has(entry.command));
    if (!present.length) continue;
    lines.push(`**${section.title}**`);
    for (const entry of present) {
      const [first, ...rest] = entry.forms;
      lines.push(`- ${form(entry, first ?? '')} ${entry.summary}${rest.length ? ` (${rest.length} more form${rest.length > 1 ? 's' : ''}: \`/help ${entry.command}\`)` : ''}`);
    }
    lines.push('');
  }
  const known = new Set([...entries().map(entry => entry.command), ...internalCommands]);
  const others = available.filter(command => !known.has(command.name)).sort((a, b) => a.name.localeCompare(b.name));
  if (others.length) {
    // A package's family of commands (pi-goal-x's /goal-list, /goal-status, …) takes one line, not a dozen.
    const family = (name: string) => name.split(/[-:]/)[0]!;
    const sizes = new Map<string, number>();
    for (const command of others) sizes.set(family(command.name), (sizes.get(family(command.name)) ?? 0) + 1);
    const shown = new Set<string>();
    lines.push('**Other commands**');
    for (const command of others) {
      const root = family(command.name);
      const related = (sizes.get(root) ?? 0) - 1;
      if (related >= 2) {
        if (shown.has(root)) continue;
        shown.add(root);
        const head = others.find(item => item.name === root) ?? command;
        const rest = others.filter(item => family(item.name) === root && item !== head).map(item => `/${item.name}`);
        lines.push(`- \`/${head.name}\` ${head.description ? head.description.split('\n')[0] : ''} Also: ${rest.join(', ')}.`.replace('  ', ' '));
      } else lines.push(`- \`/${command.name}\` ${command.description ? command.description.split('\n')[0] : ''}`.trimEnd());
    }
    lines.push('');
  }
  lines.push("Pi's own commands are also available, such as `/model`, `/settings`, `/login`, `/resume`, `/new` and `/compact`.", helpLegend);
  return { title: 'Theoria commands', ok: true, lines };
}

/** Argument completions for `/help`: the commands this session has. */
export function helpCompletions(available: { name: string }[], prefix: string) {
  const names = new Set(available.map(command => command.name));
  const wanted = prefix.trim().replace(/^\//, '');
  return entries().filter(entry => names.has(entry.command) && entry.command.startsWith(wanted))
    .map(entry => ({ value: entry.command, label: `/${entry.command}`, description: entry.summary }));
}
