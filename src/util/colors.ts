/** Zero-dependency ANSI styling with NO_COLOR / non-TTY awareness. */

let enabled =
  process.stdout.isTTY === true &&
  !process.env.NO_COLOR &&
  process.env.TERM !== 'dumb';

export function setColor(on: boolean): void {
  enabled = on;
}

export function colorEnabled(): boolean {
  return enabled;
}

/**
 * How much colour the terminal can show, in bits: 24 for truecolour, 8 for the
 * 256-colour palette, 4 for the basic sixteen, 1 for none. Node already works
 * this out from TERM, COLORTERM and the Windows build, so we ask it rather
 * than keeping our own table of terminals.
 */
export function colorDepth(): number {
  if (!enabled) return 1;
  const out = process.stdout as { getColorDepth?: () => number };
  return typeof out.getColorDepth === 'function' ? out.getColorDepth() : 4;
}

const wrap =
  (open: number, close: number) =>
  (s: string | number): string =>
    enabled ? `\u001b[${open}m${s}\u001b[${close}m` : String(s);

export const c = {
  reset: wrap(0, 0),
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  italic: wrap(3, 23),
  underline: wrap(4, 24),
  inverse: wrap(7, 27),
  strike: wrap(9, 29),

  black: wrap(30, 39),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  white: wrap(37, 39),
  gray: wrap(90, 39),

  brightRed: wrap(91, 39),
  brightGreen: wrap(92, 39),
  brightYellow: wrap(93, 39),
  brightBlue: wrap(94, 39),
  brightMagenta: wrap(95, 39),
  brightCyan: wrap(96, 39),

  bgRed: wrap(41, 49),
  bgGreen: wrap(42, 49),
  bgYellow: wrap(43, 49),
  bgBlue: wrap(44, 49),
  bgCyan: wrap(46, 49),
};

/** nave brand accent — teal-leaning cyan. */
export const accent = (s: string): string => c.brightCyan(s);
export const muted = (s: string): string => c.gray(s);

/** Visible width, ignoring ANSI escapes. */
export function width(s: string): number {
  return stripAnsi(s).length;
}

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, '');
}

export function pad(s: string, n: number): string {
  const w = width(s);
  return w >= n ? s : s + ' '.repeat(n - w);
}

export function truncate(s: string, n: number): string {
  const plain = stripAnsi(s);
  if (plain.length <= n) return s;
  return plain.slice(0, Math.max(0, n - 1)) + '…';
}

/** Indent every line of a block. */
export function indent(s: string, prefix = '  '): string {
  return s
    .split('\n')
    .map((l) => (l.length ? prefix + l : l))
    .join('\n');
}
