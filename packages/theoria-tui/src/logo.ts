/**
 * The Theta logo's animation, as pure functions of time so it can be tested without a terminal.
 *
 * Intro (`tui.logo.intro`): `shear` (the default, below) shears the Theta through one period and re-assembles it, as on
 * the Theoria website; `sweep` (`tui.logo.sweepFrames` frames) sweeps a bright band left to right across the logo, cells
 * behind it in the brand colour, cells under it glowing toward white, cells ahead not drawn yet. Then, with
 * `tui.logo.pulse`, a slow brightness pulse (`pulseMs` per cycle). Without true colour, no gradient: the intro still
 * reveals the logo, in the 256-colour brand entry, and the pulse is off.
 */

export interface Rgb { r: number; g: number; b: number }

export const hexToRgb = (hex: string): Rgb => ({
  r: Number.parseInt(hex.slice(1, 3), 16), g: Number.parseInt(hex.slice(3, 5), 16), b: Number.parseInt(hex.slice(5, 7), 16),
});

const mix = (a: Rgb, b: Rgb, t: number): Rgb => ({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t });
const scale = (a: Rgb, k: number): Rgb => ({ r: a.r * k, g: a.g * k, b: a.b * k });
const clamp = (value: number) => Math.max(0, Math.min(255, Math.round(value)));
const truecolor = (c: Rgb) => `\x1b[38;2;${clamp(c.r)};${clamp(c.g)};${clamp(c.b)}m`;
const RESET = '\x1b[39m';
const WHITE: Rgb = { r: 255, g: 255, b: 255 };

export interface LogoStyle { hex: string; ansi256: number; truecolor: boolean }

/** The band's position over the intro: from before the first column to past the last. */
export function bandAt(frame: number, frames: number, width: number): number {
  const t = frames <= 1 ? 1 : Math.min(1, frame / (frames - 1));
  return -3 + t * (width + 6);
}

/** Brightness of the settled logo at time `ms` into the pulse: between 0.72 and 1. */
export function pulseAt(ms: number, pulseMs: number): number {
  return 0.86 + 0.14 * Math.cos((2 * Math.PI * ms) / Math.max(1, pulseMs));
}

/**
 * One frame of the logo. `frame` counts intro frames; past the intro, `pulse` (0..1, or undefined for none) scales the
 * brand colour. Each row keeps its width, so the logo never shifts while it animates.
 */
export function logoFrame(rows: readonly string[], style: LogoStyle, frame: number, frames: number, pulse?: number): string[] {
  const width = Math.max(0, ...rows.map(row => [...row].length));
  const brand = hexToRgb(style.hex);
  const inIntro = frame < frames;
  const band = inIntro ? bandAt(frame, frames, width) : Infinity;
  return rows.map(row => {
    const cells = [...row];
    let out = '';
    let open = '';
    for (let x = 0; x < cells.length; x += 1) {
      const cell = cells[x]!;
      if (cell === ' ') { out += cell; continue; }
      // Ahead of the band: not drawn yet.
      if (inIntro && x > band + 1.5) { out += ' '; continue; }
      let color: string;
      if (!style.truecolor) color = `\x1b[38;5;${style.ansi256}m`;
      else if (inIntro) {
        const glow = Math.max(0, 1 - Math.abs(x - band) / 2.5);
        color = truecolor(mix(brand, WHITE, 0.75 * glow));
      } else color = truecolor(pulse === undefined ? brand : scale(brand, pulse));
      if (color !== open) { out += color; open = color; }
      out += cell;
    }
    return open ? `${out}${RESET}` : out;
  });
}

/**
 * The shear intro, after the Theoria website's hero (Theoria-Web `lib/shear.ts`): the logo is centred on a grid `width`
 * columns wide (the header's logo column, wider than the Theta, as the website's canvas is), and each row is shifted
 * cyclically by `shear × (row − middle row)` columns. With integer row offsets, a shear of exactly `width` moves every
 * row by a whole number of widths, so the Theta re-assembles exactly where it started.
 *
 * Timeline: the logo holds still for `holdMs`, shears through one full period over `shearMs` (smoothstep-eased, so it
 * starts and lands gently), then stays assembled. `shearProgress` is the eased position in 0..1, or undefined once over.
 */
export function shearProgress(elapsedMs: number, holdMs: number, shearMs: number): number | undefined {
  if (elapsedMs < holdMs) return 0;
  const t = (elapsedMs - holdMs) / Math.max(1, shearMs);
  if (t >= 1) return undefined;
  return t * t * (3 - 2 * t);
}

/** The rows centred in `width` columns and sheared by `shear` columns per row, wrapping. Every row is `width` wide. */
export function shearRows(rows: readonly string[], shear: number, width = Math.max(0, ...rows.map(row => [...row].length))): string[] {
  const logo = Math.max(0, ...rows.map(row => [...row].length));
  const grid = Math.max(width, logo);
  const left = Math.floor((grid - logo) / 2);
  const middle = Math.floor(rows.length / 2);
  return rows.map((row, y) => {
    const cells = [...' '.repeat(left), ...[...row].concat(Array(logo - [...row].length).fill(' '))];
    while (cells.length < grid) cells.push(' ');
    const shift = ((Math.round(shear * (y - middle)) % grid) + grid) % grid;
    if (!shift) return cells.join('');
    const out = new Array<string>(grid);
    cells.forEach((cell, x) => { out[(x + shift) % grid] = cell; });
    return out.join('');
  });
}

/**
 * One frame of the shear intro at eased `progress` (0..1) on a `width`-column grid. In true colour the Theta brightens
 * toward white while it moves (most at mid-shear), like the website's lighting; otherwise it stays in the 256-colour
 * brand entry. Only non-blank runs are coloured, so the padding stays plain.
 */
export function shearFrame(rows: readonly string[], style: LogoStyle, progress: number, width: number): string[] {
  const p = Math.min(1, Math.max(0, progress));
  const color = style.truecolor ? truecolor(mix(hexToRgb(style.hex), WHITE, 0.45 * Math.sin(Math.PI * p)))
    : `\x1b[38;5;${style.ansi256}m`;
  return shearRows(rows, p * Math.max(width, ...rows.map(row => [...row].length)), width)
    .map(row => row.replace(/[^ ]+/g, run => `${color}${run}${RESET}`));
}
