import { c, accent, muted, stripAnsi, truncate } from '../util/colors.ts';
import { PRODUCT, VERSION, TAGLINE } from '../version.ts';
import type { ToolResult } from '../tools/types.ts';

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export class Spinner {
  private timer: NodeJS.Timeout | null = null;
  private frame = 0;
  private text = '';
  private started = 0;
  private active = false;

  start(text: string): void {
    if (!process.stdout.isTTY) {
      if (text) process.stdout.write(`${muted(`… ${text}`)}\n`);
      return;
    }
    this.text = text;
    this.started = Date.now();
    this.active = true;
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
    if (process.stdout.isTTY) process.stdout.write('\r\u001b[2K');
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
