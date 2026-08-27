import { createInterface } from 'node:readline/promises';
import type { Interface } from 'node:readline/promises';
import { c, accent, muted } from '../util/colors.ts';
import { banner, errorBox } from './render.ts';
import { formatMb } from '../gpu/detect.ts';
import type { Services } from '../core/services.ts';
import { Session } from '../session/session.ts';
import { Permissions } from '../session/permissions.ts';
import type { PermissionRequest } from '../session/permissions.ts';
import { TodoList } from '../tools/todo.ts';
import { executeTurn, summariseTurn } from '../core/run.ts';
import {
  findCommand,
  customCommands,
  expandCustomCommand,
} from '../commands/slash.ts';
import type { SlashContext } from '../commands/slash.ts';

export interface ReplOptions {
  services: Services;
  session: Session;
  agentName: string;
  modelOverride?: string;
  initialPrompt?: string;
}

export async function runRepl(opts: ReplOptions): Promise<number> {
  const { services } = opts;
  let session = opts.session;
  const todos = new TodoList();
  const readFiles = new Set<string>();

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY === true,
    historySize: 200,
  });

  const permissions = new Permissions(services.config, (req) => askPermission(rl, req));

  const slashCtx: SlashContext = {
    services,
    session,
    permissions,
    setSession: (s) => {
      session = s;
      slashCtx.session = s;
    },
    lastStats: null,
  };

  process.stdout.write(banner(startupLine(services)));
  const warning = startupWarning(services);
  if (warning) process.stdout.write(warning + '\n');
  process.stdout.write(muted('  /help for commands · Ctrl+C to interrupt · Ctrl+D to exit\n\n'));

  let pending = opts.initialPrompt ?? null;
  let announceModel = true;
  let interrupts = 0;

  for (;;) {
    let input: string;
    if (pending !== null) {
      input = pending;
      pending = null;
      process.stdout.write(`${accent('›')} ${input}\n`);
    } else {
      try {
        input = (await rl.question(`${accent('›')} `)).trim();
      } catch {
        break; // Ctrl+D
      }
    }

    if (!input) continue;
    interrupts = 0;

    // Slash commands.
    if (input.startsWith('/')) {
      const [rawName, ...rest] = input.slice(1).split(/\s+/);
      const argText = rest.join(' ');

      const builtin = findCommand(rawName);
      if (builtin) {
        try {
          const res = await builtin.run(argText, slashCtx);
          if (res.output) process.stdout.write(`${res.output}\n\n`);
          if (res.exit) break;
          if (res.prompt) pending = res.prompt;
        } catch (err) {
          process.stdout.write(errorBox('Command failed', String((err as Error).message)) + '\n');
        }
        continue;
      }

      const custom = customCommands(services.cwd).find((cmd) => cmd.name === rawName);
      if (custom) {
        pending = expandCustomCommand(custom, argText);
        continue;
      }

      process.stdout.write(
        `${c.red('Unknown command')} ${c.bold('/' + rawName)}. ${muted('Try /help.')}\n\n`
      );
      continue;
    }

    // A model turn.
    const controller = new AbortController();
    const onSigint = () => {
      interrupts++;
      controller.abort();
    };
    rl.on('SIGINT', onSigint);
    rl.pause();

    try {
      const result = await executeTurn(
        input,
        {
          services,
          session,
          permissions,
          todos,
          readFiles,
          agentName: opts.agentName,
          modelOverride: opts.modelOverride,
          announceModel,
        },
        controller.signal
      );
      announceModel = false;

      if (result.stoppedBecause === 'error') {
        process.stdout.write(
          errorBox('Could not complete the turn', result.error ?? 'unknown error') + '\n'
        );
      } else {
        slashCtx.lastStats = {
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          tps: result.tokensPerSecond,
          steps: result.steps,
        };
        process.stdout.write(`\n${summariseTurn(result)}\n\n`);
      }
    } catch (err) {
      process.stdout.write(errorBox('Unexpected error', String((err as Error).message)) + '\n');
    } finally {
      rl.off('SIGINT', onSigint);
      rl.resume();
    }
  }

  rl.close();
  process.stdout.write(muted('\nbye\n'));
  return 0;
}

async function askPermission(rl: Interface, req: PermissionRequest): Promise<'once' | 'always' | 'no'> {
  const label = req.destructive ? c.bgRed(c.bold(' destructive ')) : accent('permission');
  process.stdout.write(`\n${label} ${c.bold(req.description)}\n`);
  if (req.target && req.target !== req.description) {
    process.stdout.write(muted(`  ${req.target}\n`));
  }
  process.stdout.write(
    muted(`  [${c.bold('y')}] yes   [${c.bold('a')}] yes, and don't ask again for this   [${c.bold('n')}] no\n`)
  );

  for (;;) {
    let answer: string;
    try {
      answer = (await rl.question(`  ${accent('?')} `)).trim().toLowerCase();
    } catch {
      return 'no';
    }
    if (answer === 'y' || answer === 'yes' || answer === '') return 'once';
    if (answer === 'a' || answer === 'always') return 'always';
    if (answer === 'n' || answer === 'no') return 'no';
    process.stdout.write(muted('  answer y, a or n\n'));
  }
}

function startupLine(services: Services): string {
  const gpu = services.gpu.gpus[0];
  const pick = services.router.ready ? services.router.pick('orchestrator') : null;
  const bits = [services.cwd];
  if (pick) bits.push(pick.model);
  if (gpu) bits.push(`${gpu.name} ${formatMb(gpu.totalMb)}`);
  const memories = services.memory.list().length;
  if (memories) bits.push(`${memories} memories`);
  if (services.skills.count) bits.push(`${services.skills.count} skills`);
  return bits.join('  ·  ');
}

function startupWarning(services: Services): string | null {
  if (!services.router.ready) return null;
  if (!services.router.models.length) {
    return errorBox(
      'No models installed',
      'The Ollama server is reachable but has no models.',
      'Run /pull to see recommendations sized to your GPU.'
    );
  }
  const pick = services.router.pick('orchestrator');
  if (pick && !pick.profile.supportsTools) {
    return `  ${c.yellow('⚠')} ${muted(
      `${pick.model} has no native tool calling — nave will use the prompted fallback, which is slower and less reliable. /models shows better options.`
    )}`;
  }
  const plan = pick ? services.router.plan(pick.profile) : null;
  if (plan && !plan.fitsFully) {
    return `  ${c.yellow('⚠')} ${muted(
      `${pick!.model} does not fit in VRAM and will partly run on CPU. /gpu explains why.`
    )}`;
  }
  return null;
}
