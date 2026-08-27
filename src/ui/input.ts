import { createInterface } from 'node:readline/promises';
import { c, accent, muted } from '../util/colors.ts';
import { suspendSpinner, panel } from './render.ts';

/**
 * Single owner of stdin, one prompt at a time.
 *
 * The first version kept one long-lived readline for the whole session and
 * reused it for permission prompts too. That deadlocks: the REPL pauses the
 * interface while a turn runs, and a nested `question()` on the same interface
 * never receives the keystroke — the user types "y", nothing happens, and the
 * spinner keeps turning over a prompt that is no longer listening.
 *
 * So: nothing holds stdin between prompts. Each line prompt builds a readline,
 * takes one line, and closes it. Choice prompts skip readline entirely and read
 * a single raw keypress. History is carried across by hand.
 */

export interface Choice<T> {
  key: string;
  label: string;
  hint?: string;
  value: T;
}

export interface ChoicePrompt<T> {
  question: string;
  detail?: string;
  tone?: 'normal' | 'danger';
  choices: Array<Choice<T>>;
  /** Returned on Enter, EOF or Ctrl+C. */
  fallback: T;
}

export type LineResult =
  | { kind: 'line'; value: string }
  | { kind: 'interrupt' }
  | { kind: 'eof' };

/**
 * Non-TTY stdin, read once and buffered.
 *
 * Building a fresh readline per prompt is fine for a human at a terminal, but
 * a pipe delivers everything at once: the first interface swallows the whole
 * buffer and drops the remainder when it closes, so the next prompt sees EOF.
 * For pipes we therefore hold the stream ourselves and hand out lines.
 */
class PipedLines {
  private buffer = '';
  private queued: string[] = [];
  private waiters: Array<(line: string | null) => void> = [];
  private ended = false;

  constructor() {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        this.queued.push(this.buffer.slice(0, nl).replace(/\r$/, ''));
        this.buffer = this.buffer.slice(nl + 1);
      }
      this.serve();
    });
    process.stdin.on('end', () => {
      if (this.buffer.trim()) this.queued.push(this.buffer.trim());
      this.buffer = '';
      this.ended = true;
      this.serve();
    });
    process.stdin.resume();
  }

  private serve(): void {
    while (this.waiters.length && this.queued.length) {
      this.waiters.shift()!(this.queued.shift()!);
    }
    if (this.ended) {
      while (this.waiters.length) this.waiters.shift()!(null);
    }
  }

  next(): Promise<string | null> {
    if (this.queued.length) return Promise.resolve(this.queued.shift()!);
    if (this.ended) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

let piped: PipedLines | null = null;

function pipedLines(): PipedLines {
  if (!piped) piped = new PipedLines();
  return piped;
}

export class InputController {
  private history: string[] = [];
  private closed = false;

  /** One line of input, distinguishing Ctrl+C from Ctrl+D. */
  async line(promptText: string): Promise<LineResult> {
    if (this.closed) return { kind: 'eof' };

    if (!process.stdin.isTTY) {
      const restore = suspendSpinner();
      process.stdout.write(promptText);
      const value = await pipedLines().next();
      restore();
      if (value === null) return { kind: 'eof' };
      process.stdout.write(`${value}\n`);
      return { kind: 'line', value };
    }

    const restoreSpinner = suspendSpinner();

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdin.isTTY === true,
      history: [...this.history],
      historySize: 200,
      removeHistoryDuplicates: true,
    });

    let interrupted = false;
    rl.on('SIGINT', () => {
      interrupted = true;
      rl.close();
    });

    const closedEarly = new Promise<null>((resolve) => {
      rl.once('close', () => resolve(null));
    });

    try {
      const answer = await Promise.race([rl.question(promptText), closedEarly]);
      if (answer === null) {
        if (interrupted) {
          process.stdout.write('\n');
          return { kind: 'interrupt' };
        }
        return { kind: 'eof' };
      }
      const history = (rl as unknown as { history?: string[] }).history;
      if (Array.isArray(history)) this.history = [...history];
      return { kind: 'line', value: answer };
    } catch {
      return { kind: 'eof' };
    } finally {
      rl.close();
      this.release();
      restoreSpinner();
    }
  }

  /**
   * A single keypress from a fixed set. No Enter needed on a terminal, which
   * is what makes approving a run of edits bearable.
   */
  async choice<T>(spec: ChoicePrompt<T>): Promise<T> {
    if (this.closed) return spec.fallback;
    const restoreSpinner = suspendSpinner();
    try {
      process.stdout.write(renderChoice(spec));
      const value = process.stdin.isTTY
        ? await this.readKey(spec)
        : await this.readLineChoice(spec);
      return value;
    } finally {
      restoreSpinner();
    }
  }

  private readKey<T>(spec: ChoicePrompt<T>): Promise<T> {
    const stdin = process.stdin;
    return new Promise<T>((resolve) => {
      const wasRaw = stdin.isRaw === true;
      let settled = false;

      const finish = (value: T, echo: string) => {
        if (settled) return;
        settled = true;
        stdin.off('data', onData);
        try {
          if (!wasRaw) stdin.setRawMode(false);
        } catch {
          /* not a TTY any more */
        }
        this.release();
        process.stdout.write(`${echo}\n\n`);
        resolve(value);
      };

      const onData = (chunk: Buffer | string) => {
        const key = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        if (key === '\u0003' || key === '\u0004') {
          // Ctrl+C / Ctrl+D decline rather than crash the turn.
          finish(spec.fallback, c.red('cancelled'));
          return;
        }
        if (key === '\r' || key === '\n') {
          const first = spec.choices[0];
          finish(first.value, accent(first.label));
          return;
        }
        const hit = spec.choices.find(
          (ch) => ch.key.toLowerCase() === key.toLowerCase()
        );
        if (hit) finish(hit.value, accent(hit.label));
        // Any other key is ignored; the prompt stays up.
      };

      try {
        stdin.setRawMode(true);
      } catch {
        /* fall through: a non-raw TTY still delivers lines */
      }
      stdin.resume();
      stdin.on('data', onData);
    });
  }

  /** Piped stdin: take a whole line and match its first character. */
  private async readLineChoice<T>(spec: ChoicePrompt<T>): Promise<T> {
    const answer = await this.line('  ');
    if (answer.kind !== 'line') return spec.fallback;
    const key = answer.value.trim().toLowerCase();
    if (!key) return spec.choices[0].value;
    const hit = spec.choices.find(
      (ch) =>
        ch.key.toLowerCase() === key[0] ||
        ch.label.toLowerCase().startsWith(key)
    );
    return hit ? hit.value : spec.fallback;
  }

  /** Hand stdin back so nothing echoes while the model is streaming. */
  private release(): void {
    try {
      if (process.stdin.isTTY && process.stdin.isRaw) process.stdin.setRawMode(false);
    } catch {
      /* ignore */
    }
    process.stdin.pause();
  }

  close(): void {
    this.closed = true;
    this.release();
  }
}

function renderChoice<T>(spec: ChoicePrompt<T>): string {
  const danger = spec.tone === 'danger';
  const body: string[] = [c.bold(spec.question)];

  if (spec.detail) {
    for (const d of spec.detail.split('\n').slice(0, 4)) body.push(muted(d));
  }
  body.push('');

  const keyWidth = Math.max(...spec.choices.map((ch) => ch.label.length));
  for (const ch of spec.choices) {
    const key = c.bold(danger ? c.red(`[${ch.key}]`) : accent(`[${ch.key}]`));
    const label = ch.label.padEnd(keyWidth);
    const hint = ch.hint ? muted(`   ${ch.hint}`) : '';
    body.push(`${key} ${label}${hint}`);
  }

  const card = panel(
    danger ? 'needs approval · destructive' : 'needs approval',
    body,
    danger ? 'bad' : 'accent'
  );
  const how = process.stdin.isTTY
    ? `  ${muted('press')} ${c.bold('y')}${muted(' / ')}${c.bold('a')}${muted(' / ')}${c.bold('n')}`
    : muted('  type a letter and press enter');
  return `${card}${how}\n`;
}
