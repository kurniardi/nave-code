/**
 * The nave mark, painted with quadrant blocks.
 *
 * A cell can hold two colours, so each one carries four subpixels: the glyph
 * says which of them take the foreground and which the background. That is
 * four times the detail of colouring whole cells, and edges stay edges instead
 * of dissolving into an average. scripts/make-logo.ts works out the split
 * ahead of time and writes src/ui/logo-art.ts — nothing decodes an image at
 * startup.
 *
 * Everything here is U+2580..U+259F, the same Block Elements range the rest of
 * the UI already draws with, so no terminal sees a missing glyph.
 */
import { colorDepth } from '../util/colors.ts';
import { LARGE, MEDIUM, SMALL } from './logo-art.ts';
import type { LogoArt } from './logo-art.ts';

/** Indexed by the cell mask: bit 0 top-left, 1 top-right, 2 bottom-left, 3 bottom-right. */
const GLYPH = [
  ' ', '▘', '▝', '▀',
  '▖', '▌', '▞', '▛',
  '▗', '▚', '▐', '▜',
  '▄', '▙', '▟', '█',
];

const RESET = '\u001b[0m';
const CELL = 13;

/** Narrowest text column worth squeezing the text into. */
const MIN_TEXT = 24;
const INDENT = 2;
const GAP = 3;

export interface Logo {
  lines: string[];
  cols: number;
  /** Columns left for text beside the mark. */
  room: number;
}

/**
 * The mark sized for this terminal, or null when it would not survive the
 * trip: fewer than 256 colours, no TTY, or too narrow to sit beside a line of
 * text. Callers fall back to the plain wordmark.
 *
 * The widest mark that still shows `textWidth` columns whole wins, because a
 * bigger mark is not worth an elided tagline. Only when nothing fits the text
 * does it drop to the widest that leaves the text merely readable.
 */
export function logo(
  columns = process.stdout.columns ?? 80,
  textWidth = MIN_TEXT
): Logo | null {
  if (colorDepth() < 8) return null;
  const sizes = [LARGE, MEDIUM, SMALL];
  const art =
    sizes.find((size) => room(size, columns) >= textWidth) ??
    sizes.find((size) => room(size, columns) >= MIN_TEXT);
  if (!art) return null;
  const deep = colorDepth() >= 24;
  return {
    cols: art.cols,
    room: room(art, columns),
    lines: art.cells.map((row) => paint(row, deep)),
  };
}

/** One column is left spare, so a full line never touches the right edge. */
function room(art: LogoArt, columns: number): number {
  return columns - INDENT - art.cols - GAP - 1;
}

/** One row of cells. Colours are only re-stated when they change. */
function paint(row: string, deep: boolean): string {
  let out = '';
  let fg = '';
  let bg = '';
  for (let at = 0; at + CELL <= row.length; at += CELL) {
    const mask = parseInt(row[at + 12], 16);
    const top = colour(row, at, 38, deep);
    if (top !== fg) {
      out += top;
      fg = top;
    }
    // A full block never shows its background, so leave it alone and keep
    // whatever the previous cell set — one less escape down a flat row.
    if (mask !== 15) {
      const bottom = colour(row, at + 6, 48, deep);
      if (bottom !== bg) {
        out += bottom;
        bg = bottom;
      }
    }
    out += GLYPH[mask];
  }
  return out + RESET;
}

function colour(row: string, at: number, layer: number, deep: boolean): string {
  const r = parseInt(row.slice(at, at + 2), 16);
  const g = parseInt(row.slice(at + 2, at + 4), 16);
  const b = parseInt(row.slice(at + 4, at + 6), 16);
  return deep
    ? `\u001b[${layer};2;${r};${g};${b}m`
    : `\u001b[${layer};5;${xterm256(r, g, b)}m`;
}

/** The six levels each channel gets in the xterm 6x6x6 colour cube. */
const CUBE = [0, 95, 135, 175, 215, 255];

/** Nearest xterm-256 index — the grey ramp for near-greys, the cube otherwise. */
function xterm256(r: number, g: number, b: number): number {
  if (Math.max(r, g, b) - Math.min(r, g, b) < 8) {
    const grey = Math.round((r + g + b) / 3);
    if (grey < 8) return 16;
    if (grey > 248) return 231;
    return 232 + Math.round(((grey - 8) / 240) * 23);
  }
  return 16 + 36 * level(r) + 6 * level(g) + level(b);
}

function level(v: number): number {
  let best = 0;
  for (let i = 1; i < CUBE.length; i++) {
    if (Math.abs(CUBE[i] - v) < Math.abs(CUBE[best] - v)) best = i;
  }
  return best;
}
