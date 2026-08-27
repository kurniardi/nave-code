import { existsSync } from 'node:fs';
import { run } from '../util/exec.ts';
import type { Tool } from './types.ts';
import { ok, fail, str, num } from './types.ts';

const DEFAULT_TIMEOUT = 120_000;
const MAX_TIMEOUT = 600_000;
const MAX_OUTPUT = 30_000;

/** Patterns that always prompt, even in acceptEdits mode. */
const DESTRUCTIVE = [
  /\brm\s+(-[a-z]*[rf][a-z]*\s+)/i,
  /\bRemove-Item\b.*-Recurse/i,
  /\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s)/i,
  /\bnpm\s+publish\b/i,
  /\bdd\s+if=/i,
  /\bmkfs\b/i,
  /\bformat\s+[a-z]:/i,
  /\bshutdown\b|\breboot\b/i,
  /\bcurl\b[^|]*\|\s*(ba)?sh/i,
  /\bdrop\s+(table|database)\b/i,
];

export interface ShellChoice {
  cmd: string;
  args: (script: string) => string[];
  label: string;
}

export function pickShell(): ShellChoice {
  const override = process.env.NAVE_SHELL;
  if (override) {
    return {
      cmd: override,
      args: (s) => ['-c', s],
      label: override,
    };
  }
  if (process.platform === 'win32') {
    return {
      cmd: 'powershell',
      args: (s) => ['-NoProfile', '-NonInteractive', '-Command', s],
      label: 'PowerShell',
    };
  }
  const shell =
    process.env.SHELL && existsSync(process.env.SHELL)
      ? process.env.SHELL
      : existsSync('/bin/bash')
        ? '/bin/bash'
        : '/bin/sh';
  return { cmd: shell, args: (s) => ['-c', s], label: shell };
}

export const bashTool: Tool = {
  name: 'bash',
  description:
    `Run a shell command in the project directory (${pickShell().label}). ` +
    'Use it for builds, tests, git and package managers. ' +
    'Do NOT use it to read, search or edit files — the read, grep, glob and edit tools are faster and safer. ' +
    'Never run interactive commands; they will hang.',
  readOnly: false,
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command line to run.' },
      description: {
        type: 'string',
        description: 'Short description of what the command does, shown to the user.',
      },
      timeout_ms: { type: 'number', description: `Timeout in ms (default ${DEFAULT_TIMEOUT}, max ${MAX_TIMEOUT}).` },
      cwd: { type: 'string', description: 'Subdirectory to run in, relative to the project root.' },
    },
    required: ['command'],
  },
  async run(args, ctx) {
    const command = str(args, 'command');
    if (!command || !command.trim()) return fail('command is required');

    const destructive = DESTRUCTIVE.some((rx) => rx.test(command));
    const perm = await ctx.permissions.check({
      tool: 'bash',
      target: command,
      description: str(args, 'description') ?? command,
      destructive,
    });
    if (!perm.allowed) return fail(`command was not run — ${perm.reason}`);

    const timeoutMs = Math.min(num(args, 'timeout_ms') ?? DEFAULT_TIMEOUT, MAX_TIMEOUT);
    const shell = pickShell();
    const sub = str(args, 'cwd');
    const cwd = sub ? `${ctx.cwd}/${sub}` : ctx.cwd;

    const started = Date.now();
    const res = await run(shell.cmd, shell.args(command), {
      cwd,
      timeoutMs,
      signal: ctx.signal,
      maxBuffer: MAX_OUTPUT * 2,
    });
    const ms = Date.now() - started;

    if (res.aborted) return fail('the command was interrupted');
    if (res.timedOut) {
      return fail(
        `command timed out after ${Math.round(timeoutMs / 1000)}s. ` +
          `Partial output:\n${clip(res.stdout + res.stderr)}`
      );
    }

    const parts: string[] = [];
    if (res.stdout.trim()) parts.push(clip(res.stdout.trimEnd()));
    if (res.stderr.trim()) parts.push(`[stderr]\n${clip(res.stderr.trimEnd())}`);
    const body = parts.join('\n\n') || '(no output)';
    const label = `${command.split('\n')[0].slice(0, 60)} → exit ${res.code} in ${fmtMs(ms)}`;

    if (res.code !== 0) {
      return {
        ok: false,
        content: `Command exited with code ${res.code}.\n\n${body}`,
        display: label,
        meta: { exitCode: res.code, ms },
      };
    }
    return ok(body, label, { exitCode: 0, ms });
  },
};

/** Read-only sibling so plan mode still allows inspection commands. */
export const bashOutputTool: Tool = {
  name: 'bash_readonly',
  description:
    'Run a read-only shell command (git status, git diff, git log, ls, cat, node --version, …). ' +
    'Rejected if the command looks like it would change anything.',
  readOnly: true,
  advanced: true,
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'A read-only command line.' },
      timeout_ms: { type: 'number', description: 'Timeout in ms.' },
    },
    required: ['command'],
  },
  async run(args, ctx) {
    const command = str(args, 'command');
    if (!command) return fail('command is required');
    if (!isReadOnlyCommand(command)) {
      return fail(
        `"${command.split(/\s+/)[0]}" is not on the read-only allow list. Use the bash tool instead.`
      );
    }
    const shell = pickShell();
    const res = await run(shell.cmd, shell.args(command), {
      cwd: ctx.cwd,
      timeoutMs: Math.min(num(args, 'timeout_ms') ?? 30_000, 120_000),
      signal: ctx.signal,
    });
    const body = clip((res.stdout + (res.stderr ? `\n[stderr]\n${res.stderr}` : '')).trim());
    return res.code === 0
      ? ok(body || '(no output)', command)
      : { ok: false, content: `exit ${res.code}\n${body}`, display: command };
  },
};

const READONLY_HEADS = new Set([
  'ls', 'dir', 'cat', 'type', 'head', 'tail', 'wc', 'pwd', 'echo', 'find',
  'which', 'where', 'stat', 'du', 'df', 'date', 'whoami', 'env', 'printenv',
  'node', 'python', 'python3', 'go', 'cargo', 'java', 'dotnet', 'tsc',
]);

export function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim();
  if (/[;&|]{1,2}|`|\$\(/.test(trimmed.replace(/\|\s*(head|tail|wc|grep|sort|uniq|jq|select-object)\b/gi, ''))) {
    return false;
  }
  const head = trimmed.split(/\s+/)[0].toLowerCase();
  if (head === 'git') {
    return /^git\s+(status|diff|log|show|branch|remote|config\s+--get|rev-parse|describe|ls-files|blame|stash\s+list)\b/i.test(trimmed);
  }
  if (head === 'npm' || head === 'pnpm' || head === 'yarn') {
    return /\b(ls|list|view|outdated|why|run\s*$)\b/i.test(trimmed);
  }
  if (READONLY_HEADS.has(head)) {
    return !/(>|>>)/.test(trimmed);
  }
  return false;
}

function clip(s: string): string {
  if (s.length <= MAX_OUTPUT) return s;
  const keepHead = Math.floor(MAX_OUTPUT * 0.7);
  const keepTail = MAX_OUTPUT - keepHead;
  return (
    `${s.slice(0, keepHead)}\n\n… [${s.length - MAX_OUTPUT} characters trimmed] …\n\n` +
    s.slice(s.length - keepTail)
  );
}

function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
