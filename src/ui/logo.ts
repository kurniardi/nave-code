/**
 * The nave wordmark.
 *
 * Every cell is a real glyph rather than a sampled pixel. The mark this
 * replaced was derived from a PNG, which meant each terminal cell held the
 * average of the pixels underneath it — at terminal resolution that reads as
 * blur, and no amount of subpixel trickery fixes it, because the source detail
 * is simply finer than a cell. Letters have no such problem: they are drawn by
 * the font at whatever size the terminal is using, so they stay sharp when the
 * reader zooms in, which is exactly what happens in a screen recording.
 *
 * Everything here is U+2500..U+259F, the Box Drawing and Block Elements ranges
 * the rest of the UI already draws with, so no terminal meets a glyph it lacks.
 */
import { c, accent, muted } from '../util/colors.ts';

/** N A V E — 6 rows, 35 columns. */
const ART = [
  '███╗   ██╗ █████╗ ██╗   ██╗███████╗',
  '████╗  ██║██╔══██╗██║   ██║██╔════╝',
  '██╔██╗ ██║███████║██║   ██║█████╗  ',
  '██║╚██╗██║██╔══██║╚██╗ ██╔╝██╔══╝  ',
  '██║ ╚████║██║  ██║ ╚████╔╝ ███████╗',
  '╚═╝  ╚═══╝╚═╝  ╚═╝  ╚═══╝  ╚══════╝',
];

/** Width of the mark in columns. */
export const COLS = 35;

/** Indent, plus a column kept spare so a full line never touches the edge. */
const INDENT = 2;
const MARGIN = 3;

export interface Logo {
  lines: string[];
  cols: number;
}

/**
 * The mark, or null when the terminal is too narrow for it. Callers fall back
 * to the single-line wordmark.
 *
 * Unlike the image it replaced, this needs no colour support: without colour
 * the glyphs still spell the name. Only width can rule it out.
 */
export function logo(columns = process.stdout.columns ?? 80): Logo | null {
  if (columns < COLS + INDENT + MARGIN) return null;
  return { cols: COLS, lines: ART.map(paint) };
}

/**
 * Solid blocks carry the letterform, the box-drawing glyphs are its shadow.
 * Dimming the shadow gives the mark depth without a second hue, and degrades
 * to plain text when colour is off.
 */
function paint(row: string): string {
  // Colour whole runs rather than single characters: one escape pair per run
  // instead of per glyph, and spaces need none at all.
  let out = '';
  for (const run of row.match(/█+|[^█ ]+| +/g) ?? []) {
    if (run[0] === '█') out += c.bold(accent(run));
    else if (run[0] === ' ') out += run;
    else out += muted(run);
  }
  return out;
}
