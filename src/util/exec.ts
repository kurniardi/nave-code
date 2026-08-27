import { spawn } from 'node:child_process';

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string;
  maxBuffer?: number;
  shell?: boolean | string;
  signal?: AbortSignal;
  onData?: (chunk: string, stream: 'stdout' | 'stderr') => void;
}

/** Promise wrapper over spawn that never rejects on a non-zero exit. */
export function run(
  cmd: string,
  args: string[] = [],
  opts: RunOptions = {}
): Promise<RunResult> {
  const maxBuffer = opts.maxBuffer ?? 2_000_000;
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell: opts.shell ?? false,
      windowsHide: true,
    });

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          kill(child);
        }, opts.timeoutMs)
      : null;

    const onAbort = () => {
      aborted = true;
      kill(child);
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
      if (stdout.length < maxBuffer) stdout += d;
      opts.onData?.(d, 'stdout');
    });
    child.stderr?.on('data', (d: string) => {
      if (stderr.length < maxBuffer) stderr += d;
      opts.onData?.(d, 'stderr');
    });

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ code, signal, stdout, stderr, timedOut, aborted });
    };

    child.on('error', (err) => {
      stderr += (stderr ? '\n' : '') + String((err as Error).message);
      finish(127, null);
    });
    child.on('close', finish);

    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });
}

function kill(child: ReturnType<typeof spawn>): void {
  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
    }).on('error', () => child.kill());
  } else {
    child.kill('SIGTERM');
    const t = setTimeout(() => child.kill('SIGKILL'), 2000);
    t.unref?.();
  }
}

/** Absolute path to a binary, or null when it is not on PATH. */
export async function which(bin: string): Promise<string | null> {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const r = await run(finder, [bin], { timeoutMs: 5000 });
  if (r.code !== 0) return null;
  const first = r.stdout.split(/\r?\n/).find((l) => l.trim());
  return first ? first.trim() : null;
}
