import { Transform } from 'node:stream';
import type { TransformCallback } from 'node:stream';

/**
 * Multi-line paste, handled before readline can split it.
 *
 * A terminal delivers a paste as ordinary keystrokes, so readline sees each
 * newline as Enter and submits every line as its own prompt — paste twenty
 * lines and nave answers twenty times. The fix is bracketed paste mode: the
 * terminal wraps pasted text in ESC[200~ … ESC[201~, which this stream strips
 * out and hands to a callback instead of passing through.
 *
 * Terminals that do not support it (older conhost) fall back to a heuristic:
 * a single read containing newlines in the middle is a paste, because a human
 * types one character per event.
 */

export const PASTE_ON = '\u001b[?2004h';
export const PASTE_OFF = '\u001b[?2004l';

const START = '\u001b[200~';
const END = '\u001b[201~';

export interface PasteFilterOptions {
  onPaste: (text: string) => void;
}

export class PasteFilter extends Transform {
  /** readline checks these to decide it is driving a terminal. */
  isTTY = true;
  private pending = '';
  private inPaste = false;
  private pasted = '';
  private onPaste: (text: string) => void;

  constructor(opts: PasteFilterOptions) {
    super();
    this.onPaste = opts.onPaste;
  }

  setRawMode(mode: boolean): this {
    process.stdin.setRawMode?.(mode);
    return this;
  }

  get isRaw(): boolean {
    return process.stdin.isRaw === true;
  }

  override _transform(
    chunk: Buffer | string,
    _enc: BufferEncoding,
    done: TransformCallback
  ): void {
    this.pending += typeof chunk === 'string' ? chunk : chunk.toString('utf8');

    for (;;) {
      if (this.inPaste) {
        const end = this.pending.indexOf(END);
        if (end < 0) {
          // Hold back a possible split marker at the tail.
          const keep = partialTailLength(this.pending, END);
          this.pasted += this.pending.slice(0, this.pending.length - keep);
          this.pending = this.pending.slice(this.pending.length - keep);
          break;
        }
        this.pasted += this.pending.slice(0, end);
        this.pending = this.pending.slice(end + END.length);
        this.inPaste = false;
        const text = this.pasted.replace(/\r\n?/g, '\n');
        this.pasted = '';
        if (text) this.onPaste(text);
        continue;
      }

      const start = this.pending.indexOf(START);
      if (start < 0) {
        const keep = partialTailLength(this.pending, START);
        const emit = this.pending.slice(0, this.pending.length - keep);
        this.pending = this.pending.slice(this.pending.length - keep);
        if (emit) this.forward(emit);
        break;
      }

      const before = this.pending.slice(0, start);
      if (before) this.forward(before);
      this.pending = this.pending.slice(start + START.length);
      this.inPaste = true;
    }

    done();
  }

  /**
   * Pass typing through; intercept anything that arrived as a block of lines,
   * which is a paste from a terminal without bracketed-paste support.
   */
  private forward(text: string): void {
    const normalised = text.replace(/\r\n/g, '\n');
    const firstBreak = normalised.search(/[\n\r]/);
    const isBlock =
      firstBreak >= 0 &&
      normalised.length > 2 &&
      firstBreak < normalised.length - 1;

    if (isBlock) {
      this.onPaste(normalised.replace(/\r/g, '\n').replace(/\n+$/, ''));
      return;
    }
    this.push(text);
  }
}

/** Length of the longest suffix of `s` that could start `marker`. */
function partialTailLength(s: string, marker: string): number {
  const max = Math.min(marker.length - 1, s.length);
  for (let n = max; n > 0; n--) {
    if (marker.startsWith(s.slice(s.length - n))) return n;
  }
  return 0;
}

/** Placeholder shown in the line while the real text is held aside. */
export function pasteMarker(index: number, lineCount: number): string {
  return `[paste #${index}: ${lineCount} lines]`;
}

const MARKER_RX = /\[paste #(\d+): \d+ lines\]/g;

/** Put the held text back where its placeholder sits. */
export function expandPastes(line: string, pastes: string[]): string {
  if (!pastes.length) return line;
  let used = false;
  const out = line.replace(MARKER_RX, (whole, n: string) => {
    const text = pastes[Number(n) - 1];
    if (text === undefined) return whole;
    used = true;
    return text;
  });
  // If the placeholders were edited away, do not silently drop the paste.
  return used ? out : [line, ...pastes].filter(Boolean).join('\n');
}
