import type { ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { config } from '@theoria/shared/config';
import { projectRoot } from '@theoria/shared/paths';
import { leanChoices } from './choices.ts';
import { describeCheckout, inventory } from './discovery.ts';
import { label, ready } from './environment.ts';
import { expectedBytes, freeBytes, gigabytes, install, releases, remove } from './install.ts';
import { leanProject, save, selectionFor, type Scope, type Selection } from './settings.ts';
import { installSearch, removeSearch, searchDir, searchState } from './search.ts';
import { extraSpec, extraSpecs, extraState, installExtra, removeExtra } from './extras.ts';
import type { LeanState } from './state.ts';
import { leanVersionOf } from './toolchain.ts';
import { currentProfile } from '@theoria/shared/harness';

/** The `/lean` menu. Each action takes the session's state and the command context. */

export const actions = [
  { value: 'config', label: 'config', description: 'Choose the Lean and Mathlib version' },
  { value: 'install', label: 'install', description: 'Install a Mathlib version (and the Lean it needs)' },
  { value: 'status', label: 'status', description: 'Show the current Lean environment' },
  { value: 'remove', label: 'remove', description: 'Delete a Mathlib version Theoria installed' },
  { value: 'search', label: 'search', description: 'Mathlib search (lean-lsp-mcp): status · install · remove' },
  { value: 'extras', label: 'extras', description: 'Lean add-ons (LeanHammer): status · install · on · off · remove' },
] as const;

type Ctx = ExtensionContext;
const projectName = (cwd: string) => projectRoot(cwd).split('/').pop() ?? 'this project';

export async function runAction(state: LeanState, ctx: Ctx, action: string, rest = '') {
  if (action === 'config') await configure(state, ctx);
  else if (action === 'search') await searchMenu(state, ctx, rest);
  else if (action === 'extras') await extrasMenu(state, ctx, rest);
  else if (action === 'install') await installMenu(state, ctx);
  else if (action === 'status') await status(state, ctx);
  else if (action === 'remove') await removeMenu(state, ctx);
  else ctx.ui.notify(`Unknown /lean action "${action}". Use ${actions.map(entry => entry.value).join(', ')}.`, 'error');
}

export async function configure(state: LeanState, ctx: Ctx, rescan = false): Promise<void> {
  const project = leanProject(ctx.cwd);
  if (project) {
    ctx.ui.notify(`This folder is a Lean project with its own toolchain (Lean ${leanVersionOf(project.toolchain)}) and dependencies. `
      + 'Theoria uses them as they are; change its lean-toolchain and lakefile to change them.', 'info');
    return;
  }
  const { choices, found } = await leanChoices({ rescan });
  const options = new Map<string, Selection | 'clear' | 'rescan' | 'install'>(choices.map(choice => [choice.label, choice.selection]));
  options.set('Install another Mathlib version…', 'install');
  options.set('Rescan this machine', 'rescan');
  options.set('Clear the choice', 'clear');

  const unbuilt = found.checkouts.filter(checkout => !checkout.built).length;
  const title = `Choose Lean and Mathlib (now: ${label(state.current)})${unbuilt ? ` · ${unbuilt} unbuilt Mathlib checkout(s) hidden` : ''}`;
  const picked = await ctx.ui.select(title, [...options.keys()]);
  const choice = picked ? options.get(picked) : undefined;
  if (!choice) return;
  if (choice === 'rescan') return configure(state, ctx, true);
  if (choice === 'install') return installMenu(state, ctx);

  const scope = await chooseScope(ctx);
  if (!scope) return;
  save(ctx.cwd, scope, choice === 'clear' ? undefined : choice);
  const environment = await state.refresh(ctx.cwd);
  const where = scope === 'project' ? `for ${projectName(ctx.cwd)}` : 'as the global default';
  if (choice === 'clear') ctx.ui.notify(`Cleared the Lean choice ${where}. Now: ${label(environment)}.`, 'info');
  else ctx.ui.notify(`${label(environment)} ${where}.${environment.problem ? ` ${environment.problem}` : ''}`, environment.problem ? 'warning' : 'info');
}

async function chooseScope(ctx: Ctx): Promise<Scope | undefined> {
  const projectLabel = `This project (${projectName(ctx.cwd)})`;
  const picked = await ctx.ui.select('Apply to', [projectLabel, 'Global default (projects without their own choice)']);
  return picked === undefined ? undefined : picked === projectLabel ? 'project' : 'global';
}

export async function installMenu(state: LeanState, ctx: Ctx) {
  if (state.installing) {
    if (await ctx.ui.confirm('Install in progress', `Mathlib ${state.installing.version} is being installed. Cancel it?`)) state.installing.controller.abort();
    return;
  }
  let tags: string[];
  try { tags = await releases(); } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : 'Could not list Mathlib releases.', 'error');
    return;
  }
  const found = await inventory();
  const have = new Set(found.checkouts.filter(checkout => checkout.built).map(checkout => checkout.version));
  const labels = tags.map(tag => `Mathlib ${tag} · Lean ${leanVersionOf(tag)}${have.has(tag) ? ' (installed)' : ''}`);
  const picked = await ctx.ui.select('Install Mathlib (newest first)', labels);
  if (!picked) return;
  const version = tags[labels.indexOf(picked)]!;
  if (have.has(version)) { ctx.ui.notify(`Mathlib ${version} is already on this machine. Choose it with /lean config.`, 'info'); return; }

  const free = freeBytes();
  const needed = expectedBytes();
  const space = free === undefined ? 'Free space could not be read.'
    : free < needed ? `Only ${gigabytes(free)} is free, less than it needs.` : `${gigabytes(free)} is free.`;
  const go = await ctx.ui.confirm(`Install Mathlib ${version}?`,
    `This clones Mathlib ${version}, downloads its prebuilt files with lake exe cache get (about ${gigabytes(needed)}) and Lean `
    + `${leanVersionOf(version)} if it is missing, then runs lake build for anything the cache did not cover (normally nothing). `
    + `${space} It runs in the background.`);
  if (!go) return;

  const controller = new AbortController();
  const cwd = ctx.cwd;
  state.installing = { version, controller };
  state.progress(`Installing Mathlib ${version}…`);
  // Not awaited: the session stays usable while it downloads, and the footer carries the progress.
  void install(version, { signal: controller.signal, onProgress: step => state.progress(`Installing: ${step}`) })
    .then(async () => {
      state.installing = undefined;
      await inventory({ rescan: true });
      await state.refresh(cwd);
      state.ui?.notify(`Mathlib ${version} is installed. Choose it with /lean config.`, 'info');
    }, async (error: unknown) => {
      state.installing = undefined;
      await state.refresh(cwd);
      state.ui?.notify(error instanceof Error ? error.message : `Installing Mathlib ${version} failed.`, 'error');
    });
}

/** `/lean extras [status | install <name> | on <name> | off <name> | remove <name>]`: add-ons such as LeanHammer. */
export async function extrasMenu(state: LeanState, ctx: Ctx, sub: string) {
  let [action = '', name = ''] = sub.trim().split(/\s+/);
  const specs = extraSpecs();
  if (!action) {
    action = (await ctx.ui.select('Lean add-ons', ['status', 'install', 'on', 'off', 'remove']))?.trim() ?? '';
    if (!action) return;
  }
  if (action !== 'status' && !name) name = specs.length === 1 ? specs[0]!.name : (await ctx.ui.select('Which add-on?', specs.map(spec => spec.name))) ?? '';
  const environment = await state.refresh(ctx.cwd);
  const mathlib = environment.mathlib?.version;
  const { selection } = selectionFor(ctx.cwd);
  if (action === 'status') {
    const lines = specs.map(spec => {
      const here = environment.extras?.find(extra => extra.name === spec.name) ?? (mathlib ? extraState(spec.name, mathlib) : undefined);
      const on = (selection && 'mathlib' in selection && selection.extras?.includes(spec.name)) || (environment.extras ?? []).some(extra => extra.name === spec.name);
      return `${spec.title} (${spec.name}): ${on ? 'on' : 'off'} here · ${here ? (here.ready ? environment.source === 'lean-project' ? 'provided by this Lake project' : `built for Mathlib ${mathlib}` : here.problem) : 'no Mathlib chosen'} · versions ${spec.versions.map(entry => entry.mathlib).join(', ')}`;
    });
    ctx.ui.notify(lines.join('\n'), 'info');
    return;
  }
  const spec = extraSpec(name);
  if (!spec) { ctx.ui.notify(`No add-on ${name}. Known: ${specs.map(entry => entry.name).join(', ')}.`, 'error'); return; }
  if (environment.source === 'lean-project') {
    ctx.ui.notify('This Lake project owns its dependencies. Add or remove the add-on in its lakefile, then run lake update and lake build.', 'info');
    return;
  }
  if (state.installingExtra && (action === 'install' || action === 'remove')) {
    if (await ctx.ui.confirm('Add-on install in progress', `${state.installingExtra.name} is being installed. Cancel it?`)) state.installingExtra.controller.abort();
    return;
  }
  if (action === 'install') {
    const checkout = environment.mathlib;
    if (!checkout) { ctx.ui.notify('Choose a Mathlib first (/lean config); the add-on is built for it.', 'warning'); return; }
    if (!spec.versions.some(entry => entry.mathlib === checkout.version)) { ctx.ui.notify(`${spec.title} has no version for Mathlib ${checkout.version}. Choose a supported Mathlib first.`, 'warning'); return; }
    if (extraState(name, checkout.version).ready) { ctx.ui.notify(`${spec.title} is already installed for Mathlib ${checkout.version}. /lean extras on ${name} turns it on.`, 'info'); return; }
    if (!await ctx.ui.confirm(`Build ${spec.title} for Mathlib ${checkout.version}?`, `A Lake workspace in Theoria's folder reuses this Mathlib's build files with a copy-on-write clone (APFS), and fetches and builds ${spec.title}. The add-on needs additional disk space. It runs in the background.`)) return;
    const controller = new AbortController();
    state.installingExtra = { name, controller };
    state.progress(`Building ${spec.title}…`);
    void installExtra(name, checkout, line => state.progress(`${spec.title}: ${line.slice(0, 60)}`), controller.signal)
      .then(async text => { state.installingExtra = undefined; await state.refresh(ctx.cwd); state.ui?.notify(text, 'info'); }, async (error: unknown) => { state.installingExtra = undefined; await state.refresh(ctx.cwd); state.ui?.notify(error instanceof Error ? error.message : String(error), 'error'); });
    return;
  }
  if (action === 'remove') {
    if (!mathlib) return;
    if (!await ctx.ui.confirm(`Remove ${spec.title} for Mathlib ${mathlib}?`, 'Its workspace is deleted; projects that use it show it as unavailable.')) return;
    removeExtra(name, mathlib);
    await state.refresh(ctx.cwd);
    ctx.ui.notify(`Removed ${spec.title} for Mathlib ${mathlib}.`, 'info');
    return;
  }
  if (action === 'on' || action === 'off') {
    if (action === 'off' && currentProfile().leanExtras.includes(name)) {
      ctx.ui.notify(`${spec.title} is required by the ${currentProfile().name} harness. Start with --harness theoria to turn it off.`, 'info');
      return;
    }
    if (!selection || !('mathlib' in selection)) { ctx.ui.notify('Add-ons go with a Mathlib: choose one first (/lean config).', 'warning'); return; }
    const extras = new Set(selection.extras ?? []);
    if (action === 'on') extras.add(name); else extras.delete(name);
    save(ctx.cwd, 'project', { mathlib: selection.mathlib, ...(extras.size ? { extras: [...extras] } : {}) });
    const next = await state.refresh(ctx.cwd);
    const extra = next.extras?.find(entry => entry.name === name);
    ctx.ui.notify(action === 'off' ? `${spec.title} is off for this project.` : extra?.ready ? `${spec.title} is on: ${label(next)}.` : `${spec.title} is on, but not usable yet: ${extra && !extra.ready ? extra.problem : ''}.`, extra && !extra.ready ? 'warning' : 'info');
    return;
  }
  ctx.ui.notify('Usage: /lean extras [status | install <name> | on <name> | off <name> | remove <name>]', 'error');
}

/** `/lean search [status | install | remove]`. */
export async function searchMenu(state: LeanState, ctx: Ctx, sub: string) {
  const s = config().leanSearch;
  let action = sub.trim().split(/\s+/)[0] ?? '';
  if (!action) {
    const { line } = await searchState(ctx.cwd, state.current);
    const choices = [`status — ${line}`, `install — ${s.package} ${s.version} into Theoria's folder`, 'remove — delete it and its /mcp entry'];
    action = (await ctx.ui.select('Mathlib search', choices))?.split(' — ')[0] ?? '';
    if (!action) return;
  }
  if (action === 'status') {
    const { state: current, line } = await searchState(ctx.cwd, await state.refresh(ctx.cwd));
    ctx.ui.notify(line, current === 'on' || current === 'off' || current === 'not-used' ? 'info' : 'warning');
    return;
  }
  if (action === 'install') {
    if (state.installing) { ctx.ui.notify(`Mathlib ${state.installing.version} is being installed; wait for it to finish.`, 'warning'); return; }
    const ok = await ctx.ui.confirm(`Install ${s.package} ${s.version}?`,
      `uv installs it with a Python of its own (about 110 MB) into ${searchDir()}, and the ${s.server} server is added to Pi's mcp.json, `
      + 'so /mcp shows it and can turn it off. It searches the session\'s Mathlib checkout. Loogle and Lean Finder are remote '
      + 'services: the agent\'s queries (statement text) leave this machine, about 3 requests per 30 s each.');
    if (!ok) return;
    state.progress(`Installing ${s.package} ${s.version}…`);
    try {
      const done = await installSearch({ onLine: line => state.progress(`Installing ${s.package}: ${line.slice(0, 60)}`) });
      state.footer();
      ctx.ui.notify(`${done} Reloading so this session loads it.`, 'info');
      await (ctx as ExtensionCommandContext).reload();
    } catch (error) {
      state.footer();
      ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
    }
    return;
  }
  if (action === 'remove') {
    if (!await ctx.ui.confirm(`Remove ${s.package}?`, `Deletes ${searchDir()} and Theoria's ${s.server} entry in mcp.json.`)) return;
    ctx.ui.notify(await removeSearch(), 'info');
    await (ctx as ExtensionCommandContext).reload();
    return;
  }
  ctx.ui.notify('Usage: /lean search [status | install | remove]', 'error');
}

export async function status(state: LeanState, ctx: Ctx) {
  const environment = await state.refresh(ctx.cwd);
  const { scope } = selectionFor(ctx.cwd);
  const source = environment.source === 'lean-project' ? 'this folder is a Lean project, which defines its own'
    : environment.source === 'none' ? 'nothing chosen; use /lean config'
      : scope === 'project' ? `chosen for ${projectName(ctx.cwd)}` : 'the global default';
  const lines = [
    `${label(environment)} (${source})`,
    ready(environment) ? 'Ready: the agent\'s shell and lean_check use it.' : `Not ready: ${environment.problem ?? 'no environment chosen.'}`,
    state.installing ? `Installing Mathlib ${state.installing.version} in the background.` : '',
    state.installingExtra ? `Installing ${state.installingExtra.name} in the background.` : '',
    (await searchState(ctx.cwd, environment)).line,
  ].filter(Boolean);
  ctx.ui.notify(lines.join('\n'), ready(environment) ? 'info' : 'warning');
}

export async function removeMenu(state: LeanState, ctx: Ctx) {
  const removable = (await inventory()).checkouts.filter(checkout => checkout.managed);
  if (!removable.length) {
    ctx.ui.notify('No Mathlib version installed by Theoria. Checkouts you made yourself are never removed from here.', 'info');
    return;
  }
  const labels = removable.map(describeCheckout);
  const picked = await ctx.ui.select('Remove a Mathlib version Theoria installed', labels);
  if (!picked) return;
  const checkout = removable[labels.indexOf(picked)]!;
  if (!await ctx.ui.confirm(`Remove Mathlib ${checkout.version}?`, 'Its files are deleted. Projects that chose it will show it as missing until it is installed again.')) return;
  remove(checkout.version);
  await inventory({ rescan: true });
  await state.refresh(ctx.cwd);
  ctx.ui.notify(`Removed Mathlib ${checkout.version}.`, 'info');
}
