import { VERSION, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth, type Component, type TUI } from '@earendil-works/pi-tui';
import { config } from '@theoria/shared/config';
import { projectRecord, projectTypes } from '@theoria/shared/project';
import { logoFrame, pulseAt, shearFrame, shearProgress } from './logo.ts';

/**
 * Theoria's header: the Theta logo, animated once at startup (logo.ts: a shear that re-assembles, as on the website), with the title and tagline under it, and beside it the project,
 * the model, the Lean environment, the research run and a few commands. The layout follows pi-open-tui's header
 * (MIT); the animation, pi-cc-header's (MIT): frames on a timer that is unreferenced and cleared when the header goes.
 *
 * The pulse stops once the conversation starts: the header then scrolls away, and redrawing lines above the screen
 * would make the terminal redraw everything.
 */

export interface HeaderInfo {
  /** Lines of state, filled in after start (the Lean environment is resolved asynchronously). */
  lines(): string[];
  tips(): string[];
}

export class TheoriaHeader implements Component {
  private frame = 0;
  /** When the shear intro started, while it runs; undefined once it is over (and for the sweep intro). */
  private shearStart: number | undefined;
  private timer: NodeJS.Timeout | undefined;
  private pulseStart = 0;
  private settled = false;
  private readonly tui: TUI;
  private readonly ctx: ExtensionContext;
  private readonly info: HeaderInfo;

  constructor(tui: TUI, ctx: ExtensionContext, info: HeaderInfo) {
    this.tui = tui;
    this.ctx = ctx;
    this.info = info;
    const logo = config().tui.logo;
    if (!logo.animate) { this.frame = logo.sweepFrames; this.settled = true; return; }
    if (logo.intro === 'shear') { this.frame = logo.sweepFrames; this.shearStart = Date.now(); }
    this.schedule();
  }

  private schedule() {
    const logo = config().tui.logo;
    const tick = () => {
      // The shear intro is timed by the clock, so a slow render never stretches it; it ends once a period is done.
      if (this.shearStart !== undefined && shearProgress(Date.now() - this.shearStart, logo.holdMs, logo.shearMs) === undefined) this.shearStart = undefined;
      if (this.shearStart === undefined) {
        if (this.frame < logo.sweepFrames) this.frame += 1;
        else if (!this.pulseStart) this.pulseStart = Date.now();
      }
      this.tui.requestRender();
      const intro = this.shearStart !== undefined || this.frame < logo.sweepFrames;
      const pulsing = !intro && logo.pulse && this.truecolor() && !this.settled;
      if (intro || pulsing) {
        // The pulse is slow: a frame every pulseMs/32 is smooth enough, and cheap.
        this.timer = setTimeout(tick, intro ? logo.frameMs : Math.max(logo.frameMs, logo.pulseMs / 32));
        this.timer.unref?.();
      } else this.timer = undefined;
    };
    this.timer = setTimeout(tick, logo.frameMs);
    this.timer.unref?.();
  }

  /** The conversation started: the logo stops where it is, at full brightness. */
  settle() {
    if (this.settled) return;
    this.settled = true;
    this.frame = config().tui.logo.sweepFrames;
    this.shearStart = undefined;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.tui.requestRender();
  }

  private truecolor() { return this.ctx.ui.theme.getColorMode() === 'truecolor'; }

  render(width: number): string[] {
    const theme = this.ctx.ui.theme;
    const { welcome, tui } = config();
    const accent = (text: string) => theme.fg('accent', text);
    const muted = (text: string) => theme.fg('muted', text);
    const dim = (text: string) => theme.fg('dim', text);
    const logoWidth = Math.max(...welcome.logo.map(row => visibleWidth(row)), visibleWidth(welcome.title));
    const leftWidth = Math.min(width - 4, Math.max(logoWidth, visibleWidth(welcome.tagline)) + 2);
    const rightWidth = width - leftWidth - 7;
    const twoColumns = rightWidth >= 24;
    const style = { hex: welcome.color.hex, ansi256: welcome.color.ansi256, truecolor: this.truecolor() };
    const pulse = !this.settled && tui.logo.pulse && this.pulseStart ? pulseAt(Date.now() - this.pulseStart, tui.logo.pulseMs) : undefined;
    // The shear runs on the whole logo column, as the website's runs on its whole canvas, so the Theta can fly apart.
    const progress = this.shearStart !== undefined ? shearProgress(Date.now() - this.shearStart, tui.logo.holdMs, tui.logo.shearMs) : undefined;
    const logo = progress !== undefined ? shearFrame(welcome.logo, style, progress, twoColumns ? leftWidth : width - 4)
      : logoFrame(welcome.logo, style, this.frame, tui.logo.sweepFrames, pulse);
    const brandTitle = logoFrame([welcome.title], style, tui.logo.sweepFrames, tui.logo.sweepFrames)[0]!;
    const left = [...logo, '', theme.bold(brandTitle), muted(welcome.tagline)];
    const right = [...this.info.lines(), '', ...(this.info.tips().length ? [accent(theme.bold('Commands')), ...this.info.tips().map(muted)] : [])];

    const paint = (text: string) => theme.fg('borderAccent', text);
    const pad = (text: string, size: number) => {
      const fitted = truncateToWidth(text, size, '…');
      return fitted + ' '.repeat(Math.max(0, size - visibleWidth(fitted)));
    };
    const center = (text: string, size: number) => {
      const fitted = truncateToWidth(text, size, '');
      const space = Math.max(0, size - visibleWidth(fitted));
      return ' '.repeat(Math.floor(space / 2)) + fitted + ' '.repeat(Math.ceil(space / 2));
    };
    if (width < logoWidth + 4) return [accent(welcome.title), dim(welcome.footnote.replace('{version}', VERSION))].map(line => truncateToWidth(line, width, ''));

    const label = ` ${accent('Θ Theoria')} ${dim(welcome.footnote.replace('{version}', VERSION))} `;
    const top = `${paint('╭─')}${label}${paint('─'.repeat(Math.max(0, width - 3 - visibleWidth(label))))}${paint('╮')}`;
    const bottom = paint(`╰${'─'.repeat(Math.max(0, width - 2))}╯`);
    const rows = Math.max(left.length, twoColumns ? right.length : 0);
    const body: string[] = [];
    for (let index = 0; index < rows; index += 1) {
      const content = twoColumns
        ? `${center(left[index] ?? '', leftWidth)} ${paint('│')} ${pad(right[index] ?? '', rightWidth)}`
        : center(left[index] ?? '', width - 4);
      body.push(`${paint('│')} ${pad(content, width - 4)} ${paint('│')}`);
    }
    return [top, ...body, bottom].map(line => truncateToWidth(line, width, ''));
  }

  invalidate() {}

  dispose() { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
}

/** The project this session is in, or the hint to create one. */
export function projectLine(cwd: string): string {
  const record = projectRecord(cwd);
  if (!record) return config().welcome.noProjectHint;
  const type = record.type ? projectTypes()[record.type]?.name ?? record.type : undefined;
  return [record.name, type].filter(Boolean).join(' · ');
}

/** The commands worth knowing in this session, in Theoria's order, those that exist here only. */
export function pickTips(pi: ExtensionAPI, count: number): string[] {
  // The first six are the header's default; the rest stand in where a harness profile lacks some of them.
  const order = ['lean', 'project', 'prove', 'autoresearch', 'latex', 'help', 'formalize', 'compress', 'attack', 'plan', 'benchmark', 'goal', 'tui'];
  const names = new Set(pi.getCommands().map(command => command.name));
  return order.filter(name => names.has(name)).slice(0, count).map(name => `/${name}`);
}
