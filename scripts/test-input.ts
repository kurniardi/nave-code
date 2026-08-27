/**
 * Exercises InputController against a simulated TTY.
 *
 * The keypress path is the one a human actually hits and the one a pipe cannot
 * reach, so it gets a real test: a PassThrough standing in for stdin, with
 * isTTY and setRawMode faked the way a terminal presents them.
 *
 *   node scripts/test-input.ts
 */
import { PassThrough } from 'node:stream';
import { setColor } from '../src/util/colors.ts';

setColor(false);

interface FakeTty extends PassThrough {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(v: boolean): FakeTty;
}

const realStdin = process.stdin;
let failures = 0;

function makeTty(): FakeTty {
  const s = new PassThrough() as FakeTty;
  s.isTTY = true;
  s.isRaw = false;
  s.setRawMode = function (v: boolean) {
    this.isRaw = v;
    return this;
  };
  return s;
}

function useStdin(stream: NodeJS.ReadableStream): void {
  Object.defineProperty(process, 'stdin', {
    value: stream,
    configurable: true,
    writable: true,
  });
}

function restoreStdin(): void {
  Object.defineProperty(process, 'stdin', {
    value: realStdin,
    configurable: true,
    writable: true,
  });
}

function assert(name: string, actual: unknown, expected: unknown): void {
  const pass = actual === expected;
  if (!pass) failures++;
  process.stdout.write(
    `${pass ? 'ok  ' : 'FAIL'} ${name}${pass ? '' : `  (got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)})`}\n`
  );
}

async function keypress(key: string): Promise<string> {
  const tty = makeTty();
  useStdin(tty);
  // Import fresh each time so the module-level piped reader is never engaged.
  const { InputController } = await import('../src/ui/input.ts');
  const input = new InputController();

  const pending = input.choice<string>({
    question: 'Approve this?',
    detail: 'some/file.ts',
    choices: [
      { key: 'y', label: 'Yes', value: 'once' },
      { key: 'a', label: 'Yes, and stop asking', value: 'always' },
      { key: 'n', label: 'No', value: 'no' },
    ],
    fallback: 'no',
  });

  setImmediate(() => tty.write(key));
  const result = await pending;
  restoreStdin();
  return result;
}

async function ignoresNoise(): Promise<string> {
  const tty = makeTty();
  useStdin(tty);
  const { InputController } = await import('../src/ui/input.ts');
  const input = new InputController();

  const pending = input.choice<string>({
    question: 'Approve this?',
    choices: [
      { key: 'y', label: 'Yes', value: 'once' },
      { key: 'n', label: 'No', value: 'no' },
    ],
    fallback: 'no',
  });

  // Arrow key, a stray letter, then the real answer.
  setImmediate(() => {
    tty.write('\u001b[A');
    tty.write('q');
    tty.write('y');
  });
  const result = await pending;
  restoreStdin();
  return result;
}

async function main(): Promise<void> {
  const quiet = { write: () => true };
  const realWrite = process.stdout.write.bind(process.stdout);
  const log = (s: string) => realWrite(s);

  // Silence the prompt rendering so the test output stays readable.
  const swallow = () => {
    (process.stdout as unknown as { write: unknown }).write = quiet.write;
  };
  const unswallow = () => {
    (process.stdout as unknown as { write: unknown }).write = realWrite;
  };

  swallow();
  const y = await keypress('y');
  const a = await keypress('a');
  const n = await keypress('n');
  const enter = await keypress('\r');
  const ctrlC = await keypress('\u0003');
  const noisy = await ignoresNoise();
  unswallow();

  log('\nInputController — simulated TTY keypresses\n\n');
  assert('y approves once', y, 'once');
  assert('a approves always', a, 'always');
  assert('n declines', n, 'no');
  assert('enter takes the first choice', enter, 'once');
  assert('ctrl+c falls back to declining', ctrlC, 'no');
  assert('unmapped keys are ignored, prompt stays up', noisy, 'once');

  log(failures ? `\n${failures} failing\n` : '\nall passing\n');
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => {
  restoreStdin();
  process.stderr.write(`${String(err)}\n`);
  process.exitCode = 1;
});
