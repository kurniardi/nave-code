import { c, accent, muted, stripAnsi, truncate, width } from '../util/colors.ts';
import { PRODUCT, VERSION, TAGLINE } from '../version.ts';
import type { ToolResult } from '../tools/types.ts';

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * The spinner that currently owns the last terminal line. Prompts need to take
 * that line over, so they suspend whatever is spinning rather than drawing on
 * top of it — a spinner repainting under a question is what made the old
 * permission prompt look frozen.
 */
let liveSpinner: Spinner | null = null;

export function suspendSpinner(): () => void {
  const s = liveSpinner;
  if (!s || !s.running) return () => {};
  const text = s.label;
  s.stop();
  return () => s.start(text);
}

export class Spinner {
  private timer: NodeJS.Timeout | null = null;
  private frame = 0;
  private text = '';
  private started = 0;
  private active = false;

  get running(): boolean {
    return this.active;
  }

  get label(): string {
    return this.text;
  }

  start(text: string): void {
    if (!process.stdout.isTTY) {
      if (text && text !== this.text) {
        this.text = text;
        process.stdout.write(`${muted(`… ${text}`)}\n`);
      }
      return;
    }
    this.text = text;
    if (!this.started) this.started = Date.now();
    this.active = true;
    liveSpinner = this;
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 90);
    this.timer.unref?.();
  }

  update(text: string): void {
    this.text = text;
  }

  private tick(): void {
    if (!this.active) return;
    const secs = Math.floor((Date.now() - this.started) / 1000);
    const elapsed = secs > 2 ? muted(` ${secs}s`) : '';
    const line = `${accent(SPIN[this.frame++ % SPIN.length])} ${this.text}${elapsed}`;
    process.stdout.write(`\r\u001b[2K${truncate(line, (process.stdout.columns ?? 80) - 1)}`);
  }

  stop(): void {
    this.active = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (liveSpinner === this) liveSpinner = null;
    if (process.stdout.isTTY) process.stdout.write('\r\u001b[2K');
  }

  /** Forget the elapsed clock — call between turns, not between steps. */
  reset(): void {
    this.stop();
    this.started = 0;
    this.text = '';
  }
}

/** Buffers streamed model output and styles each completed line. */
export class StreamWriter {
  private buffer = '';
  private inFence = false;
  private wroteAnything = false;
  private prefix: string;

  constructor(prefix = '') {
    this.prefix = prefix;
  }

  get dirty(): boolean {
    return this.wroteAnything;
  }

  write(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      this.emit(line);
    }
  }

  flush(): void {
    if (this.buffer) {
      this.emit(this.buffer);
      this.buffer = '';
    }
  }

  private emit(line: string): void {
    this.wroteAnything = true;
    process.stdout.write(this.prefix + style(line, this) + '\n');
  }

  toggleFence(): void {
    this.inFence = !this.inFence;
  }

  get fenced(): boolean {
    return this.inFence;
  }
}

function style(line: string, w: StreamWriter): string {
  if (/^\s*```/.test(line)) {
    w.toggleFence();
    return muted(line);
  }
  if (w.fenced) return c.cyan(line);
  if (/^#{1,6}\s/.test(line)) return c.bold(accent(line.replace(/^#+\s*/, '')));
  if (/^\s*[-*]\s/.test(line)) return line.replace(/^(\s*)([-*])\s/, `$1${accent('•')} `);
  if (/^\s*\d+\.\s/.test(line)) return line;
  return line
    .replace(/\*\*([^*]+)\*\*/g, (_m, t: string) => c.bold(t))
    .replace(/`([^`]+)`/g, (_m, t: string) => c.cyan(t));
}

export function banner(subtitle: string): string {
  const title = `${accent(c.bold(PRODUCT))} ${muted(`v${VERSION}`)}`;
  return [
    '',
    `  ${title}  ${muted('·')}  ${muted(TAGLINE)}`,
    `  ${muted(subtitle)}`,
    '',
  ].join('\n');
}

const G = {
  tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│', bar: '▌',
};

function termWidth(max = 78): number {
  return Math.min(max, Math.max(40, (process.stdout.columns ?? 80) - 2));
}

/** The wordmark, drawn once at the top of a session or a setup command. */
export function wordmark(subtitle?: string): string {
  const w = termWidth();
  const name = `${c.bold(accent('nave'))}${c.bold('-code')}`;
  const rule = muted(G.h.repeat(Math.max(0, w - width(`  ${PRODUCT} v${VERSION}  `) - 2)));
  const lines = [
    '',
    `  ${name} ${muted(`v${VERSION}`)} ${rule}`,
    `  ${muted(TAGLINE)}`,
  ];
  if (subtitle) lines.push(`  ${muted(subtitle)}`);
  lines.push('');
  return lines.join('\n');
}

export type Tone = 'accent' | 'ok' | 'warn' | 'bad' | 'plain';

const TONE: Record<Tone, (s: string) => string> = {
  accent: (s) => accent(s),
  ok: (s) => c.green(s),
  warn: (s) => c.yellow(s),
  bad: (s) => c.red(s),
  plain: (s) => muted(s),
};

/**
 * A bordered block. Used for anything the user must read rather than skim —
 * setup results, errors, the "what now" panel after init.
 */
export function panel(
  title: string,
  body: string[],
  tone: Tone = 'accent'
): string {
  const paint = TONE[tone];
  const w = termWidth();
  const inner = w - 2;
  const heading = ` ${title} `;
  const fill = Math.max(0, inner - width(heading) - 1);
  const out: string[] = [
    '',
    paint(G.tl) + paint(G.h) + c.bold(paint(heading)) + paint(G.h.repeat(fill)) + paint(G.tr),
  ];
  const cell = inner - 2;
  const row = (text: string): string => {
    const gap = ' '.repeat(Math.max(0, cell - width(text)));
    return `${paint(G.v)} ${text}${gap} ${paint(G.v)}`;
  };
  for (const line of body) {
    if (line === '') {
      out.push(row(''));
      continue;
    }
    for (const wrapped of wrap(line, cell)) out.push(row(wrapped));
  }
  out.push(paint(G.bl) + paint(G.h.repeat(inner)) + paint(G.br));
  out.push('');
  return out.join('\n');
}

/** A left-barred block — lighter than a panel, for grouped status lines. */
export function block(body: string[], tone: Tone = 'plain'): string {
  const paint = TONE[tone];
  return body.map((l) => `${paint(G.bar)} ${l}`).join('\n');
}

export function check(label: string, detail?: string): string {
  return `  ${c.green('✓')} ${label}${detail ? ` ${muted(detail)}` : ''}`;
}

export function warnLine(label: string, detail?: string): string {
  return `  ${c.yellow('!')} ${label}${detail ? ` ${muted(detail)}` : ''}`;
}

export function crossLine(label: string, detail?: string): string {
  return `  ${c.red('✗')} ${label}${detail ? ` ${muted(detail)}` : ''}`;
}

export function bullet(label: string): string {
  return `  ${muted('·')} ${label}`;
}

export function step(n: number, label: string): string {
  return `  ${accent(c.bold(String(n)))} ${muted('│')} ${c.bold(label)}`;
}

/** Wrap on word boundaries, ANSI-aware enough for our own styled strings. */
export function wrap(text: string, max: number): string[] {
  if (width(text) <= max) return [text];
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line && width(line) + 1 + width(word) > max) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function toolLine(name: string, args: Record<string, unknown>): string {
  return `${accent('⏺')} ${c.bold(name)}${muted(argSummary(name, args))}`;
}

export function argSummary(name: string, args: Record<string, unknown>): string {
  const pick = (k: string): string | null => {
    const v = args[k];
    return v === undefined || v === null ? null : String(v);
  };
  const first =
    pick('file_path') ??
    pick('command') ??
    pick('pattern') ??
    pick('path') ??
    pick('query') ??
    pick('name') ??
    pick('url') ??
    pick('agent') ??
    null;
  if (!first) {
    if (name === 'todo' && Array.isArray(args.todos)) return `(${args.todos.length} steps)`;
    return '';
  }
  return `(${truncate(first.split('\n')[0], 68)})`;
}

export function resultLine(result: ToolResult): string {
  const text = result.display ?? firstLine(result.content);
  const mark = result.ok ? c.green('  ⎿') : c.red('  ⎿');
  return `${mark} ${muted(truncate(text, (process.stdout.columns ?? 80) - 6))}`;
}

export function noticeLine(text: string): string {
  return muted(`  · ${text}`);
}

export function errorBox(title: string, body: string, hint?: string): string {
  const lines = [
    '',
    `${c.bgRed(c.bold(' ' + title + ' '))}`,
    '',
    ...body.split('\n').map((l) => `  ${l}`),
  ];
  if (hint) lines.push('', `  ${accent('→')} ${hint}`);
  lines.push('');
  return lines.join('\n');
}

export function table(rows: string[][], headers?: string[]): string {
  const all = headers ? [headers, ...rows] : rows;
  const widths: number[] = [];
  for (const row of all) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, stripAnsi(cell).length);
    });
  }
  const fmt = (row: string[], bold = false): string =>
    row
      .map((cell, i) => {
        const padded = cell + ' '.repeat(Math.max(0, widths[i] - stripAnsi(cell).length));
        return bold ? c.bold(padded) : padded;
      })
      .join('  ')
      .trimEnd();

  const out: string[] = [];
  if (headers) {
    out.push(fmt(headers, true));
    out.push(muted(widths.map((w) => '─'.repeat(w)).join('  ')));
  }
  for (const row of rows) out.push(fmt(row));
  return out.join('\n');
}

export function bar(fraction: number, width = 20): string {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  const colour = fraction > 0.9 ? c.red : fraction > 0.7 ? c.yellow : c.green;
  return colour('█'.repeat(filled)) + muted('░'.repeat(width - filled));
}

function firstLine(s: string): string {
  return s.split('\n')[0] ?? '';
}

export function heading(text: string): string {
  return `\n${c.bold(accent(text))}\n${muted('─'.repeat(Math.min(60, text.length + 4)))}`;
}
