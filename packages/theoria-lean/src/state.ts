import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { label, ready, resolve, type Environment } from './environment.ts';
import { applyToProcess } from './process-env.ts';
import { linkExtraTools } from './extras.ts';

export const statusKey = 'theoria-lean';

/**
 * One session's Lean state: the resolved environment the shell and `lean_check` use, the UI to report to, and an
 * install running in the background. Refreshed at session start, on every change and before each agent turn.
 */
export class LeanState {
  current: Environment = { source: 'none' };
  ui: ExtensionContext['ui'] | undefined;
  installing: { version: string; controller: AbortController } | undefined;
  installingExtra: { name: string; controller: AbortController } | undefined;

  async refresh(cwd: string): Promise<Environment> {
    this.current = await resolve(cwd);
    if (this.current.source !== 'lean-project') for (const extra of this.current.extras ?? []) {
      const problem = linkExtraTools(cwd, extra);
      if (problem) this.current = { ...this.current, problem };
    }
    applyToProcess(this.current);
    this.footer();
    return this.current;
  }

  /** The footer: the environment, or nothing while an install reports its own progress there. */
  footer() {
    if (!this.ui || this.installing || this.installingExtra) return;
    const theme = this.ui.theme;
    const text = ready(this.current)
      ? theme.fg('accent', label(this.current))
      : this.current.source === 'none' ? theme.fg('dim', 'Lean: not set · /lean') : theme.fg('warning', `${label(this.current)} · not ready`);
    this.ui.setStatus(statusKey, text);
  }

  progress(text: string) {
    this.ui?.setStatus(statusKey, this.ui.theme.fg('warning', text));
  }
}
