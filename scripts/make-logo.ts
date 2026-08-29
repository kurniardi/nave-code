/**
 * Turns the brand icon into terminal art.
 *
 * `icons/nave.png` is a 180x180 app icon and a terminal cell is nowhere near
 * that resolution, so this samples it down and writes the result to
 * src/ui/logo-art.ts. The decode happens here, once, and never at startup —
 * nave ships the sampled cells, not the PNG, so opening a session costs no
 * inflate and the published package carries no image.
 *
 * Each cell holds four subpixels drawn with a quadrant block. A cell can only
 * show two colours, so for every one this tries all sixteen ways to split the
 * four subpixels between a foreground and a background and keeps the split
 * with the least colour error. That is what makes an edge come out as an edge:
 * flattening four subpixels into their average is exactly the blur to avoid.
 *
 *   npm run logo
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(root, 'icons', 'nave.png');
const OUT = join(root, 'src', 'ui', 'logo-art.ts');

/**
 * Widths in cells, widest first. A cell is about twice as tall as it is wide,
 * so N cells across is N/2 rows down for a square icon, and the subpixel grid
 * is 2N by N. src/ui/logo.ts picks the widest that still leaves room for the
 * text beside it.
 */
const SIZES: Array<{ name: string; cols: number }> = [
  { name: 'LARGE', cols: 32 },
  { name: 'MEDIUM', cols: 24 },
  { name: 'SMALL', cols: 16 },
];

interface Image {
  width: number;
  height: number;
  channels: number;
  pixels: Buffer;
}

/**
 * Enough of PNG to read our own icon: 8-bit truecolour, no interlacing. Any
 * other shape is a mistake in the source file, not a case worth supporting.
 */
function decodePng(buf: Buffer): Image {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const depth = buf[24];
  const colourType = buf[25];
  const interlace = buf[28];
  if (depth !== 8 || (colourType !== 2 && colourType !== 6) || interlace !== 0) {
    throw new Error(
      `unsupported PNG (depth ${depth}, colour type ${colourType}, interlace ${interlace}) — ` +
        're-export as 8-bit RGB or RGBA, non-interlaced'
    );
  }
  const channels = colourType === 6 ? 4 : 3;

  const idat: Buffer[] = [];
  for (let at = 8; at + 8 <= buf.length; ) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString('ascii', at + 4, at + 8);
    if (type === 'IDAT') idat.push(buf.subarray(at + 8, at + 8 + length));
    if (type === 'IEND') break;
    at += length + 12;
  }
  if (!idat.length) throw new Error('PNG has no image data');

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);

  // Undo the per-scanline filters. Each byte is predicted from its left (a),
  // upper (b) and upper-left (c) neighbours; byte 0 of a line says which.
  let at = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[at++];
    const line = raw.subarray(at, at + stride);
    at += stride;
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const above = y ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? row[x - channels] : 0;
      const b = above ? above[x] : 0;
      const cc = above && x >= channels ? above[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - cc;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - cc);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : cc;
      } else if (filter !== 0) throw new Error(`unknown PNG filter ${filter}`);
      row[x] = v & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

type Rgb = [number, number, number];

/** Average every source pixel that lands in a target subpixel — no aliasing. */
function sample(img: Image, cols: number, rows: number): Rgb[][] {
  const out: Rgb[][] = [];
  for (let ry = 0; ry < rows; ry++) {
    const y0 = Math.floor((ry * img.height) / rows);
    const y1 = Math.max(y0 + 1, Math.floor(((ry + 1) * img.height) / rows));
    const line: Rgb[] = [];
    for (let rx = 0; rx < cols; rx++) {
      const x0 = Math.floor((rx * img.width) / cols);
      const x1 = Math.max(x0 + 1, Math.floor(((rx + 1) * img.width) / cols));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * img.width + x) * img.channels;
          r += img.pixels[i];
          g += img.pixels[i + 1];
          b += img.pixels[i + 2];
          n++;
        }
      }
      line.push([Math.round(r / n), Math.round(g / n), Math.round(b / n)]);
    }
    out.push(line);
  }
  return out;
}

function mean(picked: Rgb[]): Rgb {
  const n = picked.length;
  if (!n) return [0, 0, 0];
  return [
    Math.round(picked.reduce((s, p) => s + p[0], 0) / n),
    Math.round(picked.reduce((s, p) => s + p[1], 0) / n),
    Math.round(picked.reduce((s, p) => s + p[2], 0) / n),
  ];
}

function error(a: Rgb, b: Rgb): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

interface Cell {
  mask: number;
  fg: Rgb;
  bg: Rgb;
}

/**
 * The best two-colour rendering of one cell. Bit i of the mask means subpixel
 * i takes the foreground, in the order top-left, top-right, bottom-left,
 * bottom-right. Mask 15 is a full block, which is where a flat cell lands and
 * which needs only one colour sent.
 */
function quantise(quad: Rgb[]): Cell {
  let best: Cell = { mask: 15, fg: quad[0], bg: quad[0] };
  let least = Infinity;
  for (let mask = 1; mask < 16; mask++) {
    const fgPixels: Rgb[] = [];
    const bgPixels: Rgb[] = [];
    for (let i = 0; i < 4; i++) (mask & (1 << i) ? fgPixels : bgPixels).push(quad[i]);
    const fg = mean(fgPixels);
    const bg = bgPixels.length ? mean(bgPixels) : fg;
    let err = 0;
    for (let i = 0; i < 4; i++) err += error(quad[i], mask & (1 << i) ? fg : bg);
    if (err < least) {
      least = err;
      best = { mask, fg, bg };
    }
  }
  return best.mask === 15 ? { mask: 15, fg: best.fg, bg: best.fg } : best;
}

const hex = (n: number): string => n.toString(16).padStart(2, '0');

/** One string per row; each cell is 13 characters — fg, bg, then the mask. */
function encode(img: Image, cols: number): { rows: number; cells: string[] } {
  const rows = Math.round(cols / 2);
  const grid = sample(img, cols * 2, rows * 2);
  const out: string[] = [];
  for (let r = 0; r < rows; r++) {
    const top = grid[r * 2];
    const bottom = grid[r * 2 + 1] ?? top;
    let line = '';
    for (let x = 0; x < cols; x++) {
      const cell = quantise([top[x * 2], top[x * 2 + 1], bottom[x * 2], bottom[x * 2 + 1]]);
      line += cell.fg.map(hex).join('') + cell.bg.map(hex).join('') + cell.mask.toString(16);
    }
    out.push(line);
  }
  return { rows, cells: out };
}

const image = decodePng(readFileSync(SOURCE));

const body = SIZES.map(({ name, cols }) => {
  const art = encode(image, cols);
  const rows = art.cells.map((line) => `    '${line}',`).join('\n');
  return `export const ${name}: LogoArt = {\n  cols: ${cols},\n  rows: ${art.rows},\n  cells: [\n${rows}\n  ],\n};`;
}).join('\n\n');

writeFileSync(
  OUT,
  `/**
 * Generated by scripts/make-logo.ts from icons/nave.png — do not edit by hand.
 *
 * One string per terminal row. Every 13 characters is one cell: six hex digits
 * of foreground, six of background, then one digit saying which of the cell's
 * four subpixels take the foreground. src/ui/logo.ts draws each as a quadrant
 * block.
 */

export interface LogoArt {
  /** Width in cells. The subpixel grid is twice this, each way. */
  cols: number;
  /** Height in cells — half the width, so the icon comes out square. */
  rows: number;
  cells: string[];
}

${body}
`,
  'utf8'
);

const summary = SIZES.map((s) => `${s.cols}x${s.cols / 2}`).join(', ');
process.stdout.write(`wrote src/ui/logo-art.ts from icons/nave.png (${summary} cells)\n`);
