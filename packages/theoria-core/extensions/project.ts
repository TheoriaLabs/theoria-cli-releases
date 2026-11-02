import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { leanChoices, saveLeanSelection, type Selection } from '@theoria/pi-lean/api';
import { provideActions } from '@theoria/shared/actions';
import { registerCard } from '@theoria/shared/card';
import { managedServers, piAgentDir, piMcpConfig, saveTypeServers, shippedDirectTools } from '@theoria/mcp/api';
import { config, reloadConfig } from '@theoria/shared/config';
import { componentOn } from '@theoria/shared/harness';
import { projectRoot } from '@theoria/shared/paths';
import { measureProgress, projectRow, refreshInventory, statusLines } from '@theoria/pi-workflows/api';
import { ago } from '@theoria/shared/verdicts';
import {
  createProject, launchDirEnv, listProjects, newProjectDir, ProjectError, projectRecord, projectsRoot, projectType, projectTypeEnv,
  projectTypes, saveProjectRecord, type ProjectRecord, type ProjectTypeSettings,
} from '@theoria/shared/project';

/**
 * Projects. `/project` opens a menu: `list` (browse and switch, resuming a project's last conversation), `status`
 * (what Lean says about its theorems, its goals, its recent runs), `type`, `new`; each also works typed directly.
 * `/new-project` stays as a shortcut. A project's type decides which Theoria commands it gets, so switching project or
 * type starts the session again, which registers the commands that project's type enables.
 */

type Ctx = ExtensionCommandContext;
const later = 'Choose later with /lean in the project';

const summary = (settings: ProjectTypeSettings) => [
  [...settings.workflows, ...(settings.latex ? ['latex'] : [])].map(name => `/${name}`).join(' ') || 'no Theoria workflows yet',
  settings.lean ? 'Lean' : '',
].filter(Boolean).join(' · ');

export default function projects(pi: ExtensionAPI) {
  if (!componentOn('project')) return;
  const card = registerCard(pi, 'theoria-project');

  pi.on('before_agent_start', (event, ctx) => {
    const root = projectRoot(ctx.cwd);
    const record = projectRecord(root);
    event.systemPromptOptions.sections['project-scope'] = record?.name
      ? `Current Theoria project: ${record.name}\nProject root: ${root}\nResearch records belong to ${root}/${config().paths.projectDir}. Parent, sibling and nested projects have separate records; use another project's material only when the user explicitly requests it.`
      : `No Theoria project is selected at ${root}. For project research or paper writing, ask the user to choose a project with /project list or create one with /new-project. Do not infer the active project from nested folders or benchmark artifacts.`;
  });

  // A broken project file disables the type's commands; say so once, here, rather than in every package.
  pi.on('session_start', (_event, ctx) => {
    try { projectType(ctx.cwd); } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(`${error instanceof Error ? error.message : String(error)} Theoria's project commands are off until it is fixed; /project type sets a valid one.`, 'error');
    }
  });

  async function chooseType(ctx: Ctx, title: string): Promise<string | undefined> {
    const types = Object.entries(projectTypes());
    const labels = types.map(([, settings]) => `${settings.name} — ${settings.description} · ${summary(settings)}`);
    const picked = await ctx.ui.select(title, labels);
    return picked ? types[labels.indexOf(picked)]![0] : undefined;
  }

  /** `/new-project` and `/project new`: name, type, Lean for a type that uses it, then into the new folder. */
  async function newProject(args: string, ctx: Ctx) {
    if (!ctx.hasUI) return;
    if (!ctx.isIdle()) { ctx.ui.notify('The agent is busy. Wait for it to finish, or press Esc.', 'warning'); return; }
    const name = args.trim() || (await ctx.ui.input('Project name', 'e.g. Legendre conjecture'))?.trim();
    if (!name) return;
    const type = await chooseType(ctx, `Project type for "${name}"`);
    if (!type) return;
    const settings = projectTypes()[type]!;
    const dir = newProjectDir(name, ctx.cwd);

    let lean: Selection | undefined;
    if (settings.lean) {
      const { choices } = await leanChoices();
      if (!choices.length) ctx.ui.notify('No Lean or Mathlib is installed yet; use /lean install in the project.', 'warning');
      else {
        const picked = await ctx.ui.select('Lean and Mathlib for this project', [...choices.map(choice => choice.label), later]);
        if (picked === undefined) return;
        lean = choices.find(choice => choice.label === picked)?.selection;
      }
    }
    const leanText = !settings.lean ? 'none' : lean ? ('mathlib' in lean ? `Mathlib ${lean.mathlib}` : `Lean ${lean.lean}`) : 'chosen later with /lean';
    if (!await ctx.ui.confirm(`Create ${name}?`, `${settings.name} project in ${dir}\nCommands: ${summary(settings)}\nLean: ${leanText}`)) return;

    let created: string[];
    try {
      created = (await createProject(dir, name, type)).created;
      if (lean) saveLeanSelection(dir, 'project', lean);
    } catch (error) {
      ctx.ui.notify(error instanceof ProjectError || error instanceof Error ? error.message : String(error), 'error');
      return;
    }
    const lines = [
      `${settings.name} · ${dir}`, '',
      `Created ${created.map(entry => `\`${entry}\``).join(', ')}${lean ? `, and chose ${leanText}` : ''}.`,
      `Commands: ${summary(settings)}.`,
    ];
    await moveInto(ctx, dir, card(`New project: ${name}`, lines, { ok: true }), false);
  }

  pi.registerCommand('new-project', {
    description: `Create a Theoria project in ${config().project.parentDir} and choose its type`,
    handler: newProject,
  });

  /**
   * Moves the session into a project folder. Pi's working directory belongs to a session, so Theoria switches to a
   * session file of that folder: its most recent conversation when `resume` and there is one, otherwise a new one
   * (Pi's own header, written here). Pi then creates the extensions again, so the commands match the project.
   */
  async function moveInto(ctx: Ctx, dir: string, message: ReturnType<typeof card>, resume: boolean) {
    let file = resume ? lastConversation(dir)?.file : undefined;
    if (!file) {
      const session = SessionManager.create(dir);
      file = session.getSessionFile();
      const header = session.getHeader();
      if (!file || !header) {
        ctx.ui.notify(`Start Theoria in the project: cd ${dir} && theoria`, 'info');
        return;
      }
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(header)}\n`, { flag: 'wx' });
    }
    const previous = process.cwd();
    // Extensions decide what to register from the process's directory; a one-run --project-type no longer applies.
    process.chdir(dir);
    delete process.env[projectTypeEnv];
    try {
      const result = await ctx.switchSession(file, { withSession: async next => {
        if (safeReal(projectRoot(next.cwd)) !== safeReal(projectRoot(dir)) || safeReal(projectRoot(next.sessionManager.getCwd())) !== safeReal(projectRoot(dir))) {
          throw new Error(`Project switch did not bind the session to ${dir}. Restart Theoria in that directory.`);
        }
        await next.sendMessage(message);
      } });
      if (!result.cancelled) return;
      process.chdir(previous);
      ctx.ui.notify(`The session did not switch. Start Theoria in the project: cd ${dir} && theoria`, 'warning');
    } catch (error) {
      process.chdir(previous);
      throw error;
    }
  }

  /** The projects `/project list` offers: those in the projects folder, and the current one when it is elsewhere. */
  function knownProjects(ctx: Ctx): { dir: string; record: Partial<ProjectRecord> }[] {
    const listed = listProjects(projectsRoot(process.env[launchDirEnv] ?? ctx.cwd));
    const here = projectRoot(ctx.cwd);
    const record = projectRecord(here);
    const outside = record && config().project.listShowOutside && !listed.some(entry => entry.dir === safeReal(here));
    return outside ? [{ dir: safeReal(here), record }, ...listed] : listed;
  }

  async function list(ctx: Ctx) {
    if (!ctx.hasUI) return;
    const projects = knownProjects(ctx);
    const here = safeReal(projectRoot(ctx.cwd));
    const create = '+ New project…';
    if (!projects.length) {
      if (await ctx.ui.confirm('No projects yet', `Nothing in ${projectsRoot(process.env[launchDirEnv] ?? ctx.cwd)}. Create one?`)) await newProject('', ctx);
      return;
    }
    const labels = projects.map(project => `${project.dir === here ? '● ' : '  '}${projectRow(project.dir, project.record, lastConversation(project.dir)?.modified)}`);
    const picked = await ctx.ui.select(`Projects (${projects.length}) · ● is this one`, [...labels, create]);
    if (!picked) return;
    if (picked === create) { await newProject('', ctx); return; }
    const project = projects[labels.indexOf(picked)]!;
    if (project.dir === here) { ctx.ui.notify(`You are in ${project.record.name ?? project.dir}. /project status shows its progress.`, 'info'); return; }
    if (!ctx.isIdle()) { ctx.ui.notify('The agent is busy. Wait for it to finish, or press Esc, before switching project.', 'warning'); return; }
    const previous = lastConversation(project.dir);
    let resume = false;
    if (previous) {
      const resumeLabel = `Resume the last conversation (${ago(previous.modified)})`;
      const choice = await ctx.ui.select(`Switch to ${project.record.name ?? project.dir}`, [resumeLabel, 'Start a new conversation']);
      if (!choice) return;
      resume = choice === resumeLabel;
    }
    const name = project.record.name ?? project.dir.split('/').pop()!;
    await moveInto(ctx, project.dir, card(`Project: ${name}`, [
      projectRow(project.dir, project.record, previous?.modified), '',
      resume ? 'Resumed the last conversation.' : 'New conversation.',
      '/project status shows its proofs, formalizations, goals and recent runs.',
    ], { ok: true, tone: 'accent' }), resume);
  }

  async function status(args: string, ctx: Ctx) {
    if (!projectRecord(ctx.cwd)) { ctx.ui.notify(`Not a Theoria project: ${projectRoot(ctx.cwd)}. /project list or /project new.`, 'info'); return; }
    const cwd = ctx.cwd;
    if (args === 'refresh') {
      ctx.ui.notify('Lean is checking the project…', 'info');
      await refreshInventory(cwd).then(() => measureProgress(cwd)).catch(error => ctx.ui.notify(String(error), 'warning'));
    }
    const { lines, stale } = await statusLines(cwd);
    let line: string;
    try {
      const current = projectType(cwd);
      line = current.source === 'flag' ? `Type from --${config().project.flag} for this run` : current.source === 'default' ? 'Type is the default; /project type sets one' : '';
    } catch (error) { line = error instanceof Error ? error.message : String(error); }
    ctx.ui.notify([...lines.slice(0, 1), ...(line ? [line] : []), ...lines.slice(1)].join('\n'), 'info');
    // Out of date: Lean rechecks in the background, and says when the numbers are current.
    if (stale && args !== 'refresh') {
      void refreshInventory(cwd).then(() => measureProgress(cwd)).then(
        () => { if (ctx.hasUI) ctx.ui.notify('Lean finished checking the project: /project status shows the current numbers.', 'info'); },
        () => { /* shown by the next /project status */ },
      );
    }
  }

  /**
   * `/project servers`: which MCP servers the current project type loads. Theoria's servers load where the type lists
   * them; servers you added load everywhere unless the type shows only the listed ones. Saved to the user config.
   */
  async function servers(ctx: Ctx) {
    if (!ctx.hasUI) return;
    let current;
    try { current = projectType(ctx.cwd); } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error'); return; }
    const loaded = (await piMcpConfig()).loadMcpConfig({ agentDir: piAgentDir(), cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
    const managed = managedServers();
    let changed = false;
    for (;;) {
      const type = projectTypes()[current.type]!;
      const listed = new Set(type.mcpServers.map(item => item.server));
      const names = [...new Set([...loaded.servers.map(entry => entry.name), ...listed, ...managed])].sort();
      const rows = names.map(name => {
        const entry = loaded.servers.find(server => server.name === name);
        const own = entry?.scope === 'project' && !entry.override;
        const isManaged = managed.includes(name);
        const loads = own || listed.has(name) || (!isManaged && type.otherServers === 'show');
        const kind = own ? 'this project\'s .pi/mcp.json; always loads' : isManaged ? 'Theoria' : 'yours';
        const notes = [kind, ...(entry ? [] : ['not in mcp.json']), ...(entry?.config.enabled === false ? ['off in /mcp'] : [])];
        return { name, own, isManaged, label: `${loads ? '✓' : '✗'} ${name} · ${notes.join(' · ')}` };
      });
      const other = `Your other servers: ${type.otherServers === 'show' ? 'load in every' : 'load only where listed in'} ${type.name} project → change`;
      const picked = await ctx.ui.select(`MCP servers for ${type.name} projects (✓ loads) · /mcp turns servers on and off`, [...rows.map(row => row.label), other]);
      if (!picked) break;
      let next = { mcpServers: [...type.mcpServers], otherServers: type.otherServers };
      if (picked === other) next = { ...next, otherServers: type.otherServers === 'show' ? 'hide' : 'show' };
      else {
        const row = rows.find(candidate => candidate.label === picked)!;
        if (row.own) { ctx.ui.notify(`${row.name} is defined by this project's .pi/mcp.json and always loads here; /mcp turns it off.`, 'info'); continue; }
        if (!row.isManaged && type.otherServers === 'show') {
          ctx.ui.notify(`Your servers all load in ${type.name} projects. Choose "${other.split(':')[0]}" first to load only the ones listed.`, 'info');
          continue;
        }
        next.mcpServers = listed.has(row.name)
          ? next.mcpServers.filter(item => item.server !== row.name)
          : [...next.mcpServers, { server: row.name, directTools: shippedDirectTools(row.name) }];
      }
      try { saveTypeServers(current.type, next); reloadConfig(); changed = true; } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
        return;
      }
    }
    if (changed) {
      reloadConfig();
      ctx.ui.notify('Saved. Reloading so this session loads the servers its type now lists.', 'info');
      await ctx.reload();
    }
  }

  async function changeType(wanted: string | undefined, ctx: Ctx) {
    const type = wanted || await chooseType(ctx, 'Project type');
    if (!type) return;
    try { saveProjectRecord(ctx.cwd, { type, ...(projectRecord(ctx.cwd)?.name ? {} : { name: projectRoot(ctx.cwd).split('/').pop() ?? type }) }); } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
      return;
    }
    ctx.ui.notify(`${projectTypes()[type]!.name}: ${summary(projectTypes()[type]!)}. Reloading so the commands match.`, 'info');
    await ctx.reload();
  }

  const actions = [
    { value: 'list', description: 'Browse projects and switch to one' },
    { value: 'status', description: 'Proofs, formalizations, goals and recent runs of this project' },
    { value: 'type', description: 'Change this project\'s type (and its commands)' },
    { value: 'new', description: 'Create a project' },
    { value: 'servers', description: 'Which MCP servers (/mcp) this project type loads' },
  ];

  provideActions(pi, () => [{
    name: 'project-status', usage: '/project status', summary: 'What Lean says about the project\'s theorems, its goals and recent verdicts.', execution: 'inline',
    run: async (_args, actx) => {
      if (!projectRecord(actx.cwd)) return { ok: false, text: 'Not a Theoria project.' };
      const { lines } = await statusLines(actx.cwd);
      return { ok: true, text: lines.join('\n') };
    },
  }]);

  pi.registerCommand('project', {
    description: 'Projects: list (switch) · status [refresh] · type [type] · new [name] · servers',
    getArgumentCompletions: prefix => [...actions.map(action => action.value), 'status refresh', ...Object.keys(projectTypes()).map(type => `type ${type}`)]
      .filter(value => value.startsWith(prefix.trim())).map(value => ({ value, label: value, description: actions.find(action => action.value === value)?.description })),
    handler: async (args, ctx) => {
      let [action = '', ...rest] = args.trim().split(/\s+/).filter(Boolean);
      if (!action) {
        if (!ctx.hasUI) return;
        const here = projectRecord(ctx.cwd)?.name;
        const picked = await ctx.ui.select(here ? `Project: ${here}` : 'Projects', actions.map(entry => `${entry.value} — ${entry.description}`));
        action = picked?.split(' — ')[0] ?? '';
        if (!action) return;
      }
      if (action === 'list') return list(ctx);
      if (action === 'status') return status(rest[0] ?? '', ctx);
      if (action === 'type') return changeType(rest[0], ctx);
      if (action === 'new') return newProject(rest.join(' '), ctx);
      if (action === 'servers') return servers(ctx);
      ctx.ui.notify('Usage: /project [list | status [refresh] | type [type] | new [name] | servers]', 'error');
    },
  });
}

/** The most recent conversation in a project folder, when there is one. */
function lastConversation(dir: string): { file: string; modified: Date } | undefined {
  try {
    const session = SessionManager.continueRecent(dir);
    const header = session.getHeader();
    if (!header || safeReal(projectRoot(header.cwd)) !== safeReal(projectRoot(dir))) return undefined;
    const file = session.getSessionFile();
    return file && existsSync(file) ? { file, modified: statSync(file).mtime } : undefined;
  } catch { return undefined; }
}

const safeReal = (path: string) => { try { return realpathSync(path); } catch { return path; } };
