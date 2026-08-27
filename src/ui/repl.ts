import { c, accent, muted } from '../util/colors.ts';
import { wordmark, panel, errorBox, block } from './render.ts';
import { InputController } from './input.ts';
import { formatMb } from '../gpu/detect.ts';
import type { Services } from '../core/services.ts';
import { Session } from '../session/session.ts';
import { Permissions } from '../session/permissions.ts';
import type { PermissionRequest } from '../session/permissions.ts';
import { TodoList } from '../tools/todo.ts';
import { executeTurn, summariseTurn } from '../core/run.ts';
import { findCommand, customCommands, expandCustomCommand } from '../commands/slash.ts';
import type { SlashContext } from '../commands/slash.ts';

export interface ReplOptions {
  services: Services;
  session: Session;
  agentName: string;
  modelOverride?: string;
  initialPrompt?: string;
}

type Answer = 'once' | 'always' | 'no';

export async function runRepl(opts: ReplOptions): Promise<number> {
  const { services } = opts;
  let session = opts.session;
  const todos = new TodoList();
  const readFiles = new Set<string>();
  const input = new InputController();

  const permissions = new Permissions(services.config, (req) =>
    askPermission(input, req)
  );

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

  process.stdout.write(wordmark());
  process.stdout.write(sessionHeader(services, permissions) + '\n');
  for (const w of startupWarnings(services)) process.stdout.write(w + '\n');
  process.stdout.write(
    '\n' +
      muted(`  ${c.bold('/help')} for commands   ${c.bold('Ctrl+C')} interrupt   ${c.bold('Ctrl+D')} exit`) +
      '\n\n'
  );

  let pending = opts.initialPrompt ?? null;
  let announceModel = true;
  let emptyInterrupts = 0;

  for (;;) {
    let text: string;

    if (pending !== null) {
      text = pending;
      pending = null;
      process.stdout.write(`${accent('›')} ${text}\n`);
    } else {
      const result = await input.line(`${accent('›')} `);
      if (result.kind === 'eof') break;
      if (result.kind === 'interrupt') {
        emptyInterrupts++;
        if (emptyInterrupts >= 2) break;
        process.stdout.write(muted('  (Ctrl+C again to exit, or Ctrl+D)\n'));
        continue;
      }
      text = result.value.trim();
    }

    if (!text) continue;
    emptyInterrupts = 0;

    if (text.startsWith('/')) {
      const [rawName, ...rest] = text.slice(1).split(/\s+/);
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
        `  ${c.red('✗')} unknown command ${c.bold('/' + rawName)} ${muted('— /help lists them')}\n\n`
      );
      continue;
    }

    // A model turn. stdin is unowned while this runs, so Ctrl+C reaches us as
    // a process signal rather than through a readline nobody is reading.
    const controller = new AbortController();
    const onSigint = () => controller.abort();
    process.on('SIGINT', onSigint);

    try {
      const result = await executeTurn(
        text,
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
      process.off('SIGINT', onSigint);
    }
  }

  input.close();
  process.stdout.write(muted('\n  bye\n\n'));
  return 0;
}

async function askPermission(
  input: InputController,
  req: PermissionRequest
): Promise<Answer> {
  return input.choice<Answer>({
    question: req.description,
    detail: req.target && req.target !== req.description ? req.target : undefined,
    tone: req.destructive ? 'danger' : 'normal',
    choices: [
      { key: 'y', label: 'Yes', value: 'once' },
      {
        key: 'a',
        label: 'Yes, and stop asking',
        hint: forWhat(req),
        value: 'always',
      },
      { key: 'n', label: 'No', hint: 'tell nave what to do instead', value: 'no' },
    ],
    fallback: 'no',
  });
}

function forWhat(req: PermissionRequest): string {
  if (req.tool === 'bash' && req.target) {
    return `for ${req.target.trim().split(/\s+/)[0]} commands`;
  }
  return `for ${req.tool}`;
}

function sessionHeader(services: Services, permissions: Permissions): string {
  const pick = services.router.ready ? services.router.pick('orchestrator') : null;
  const gpu = services.gpu.gpus[0];
  const memories = services.memory.list().length;

  const rows: string[] = [];
  rows.push(`${muted('project')}  ${c.bold(services.cwd)}`);

  if (pick) {
    const plan = services.router.plan(pick.profile);
    const fit = plan.fitsFully ? c.green('all on GPU') : c.yellow(`${plan.numGpu ?? '?'} layers on GPU`);
    rows.push(
      `${muted('model  ')}  ${c.bold(pick.model)} ${muted(`· ${Math.round(plan.numCtx / 1024)}k context ·`)} ${fit}`
    );
  }
  if (gpu) {
    rows.push(`${muted('gpu    ')}  ${gpu.name} ${muted(`· ${formatMb(gpu.totalMb)}`)}`);
  }

  const context: string[] = [];
  context.push(memories ? `${c.bold(String(memories))} memories` : muted('no memories yet'));
  if (services.skills.count) context.push(`${c.bold(String(services.skills.count))} skills`);
  context.push(`${c.bold(permissions.currentMode)} permissions`);
  rows.push(`${muted('context')}  ${context.join(muted('  ·  '))}`);

  return block(rows, 'accent');
}

function startupWarnings(services: Services): string[] {
  if (!services.router.ready) return [];
  const out: string[] = [];

  if (!services.router.models.length) {
    return [
      panel(
        'No models installed',
        [
          'The Ollama server is running but has nothing to run.',
          '',
          `${accent('→')} ${c.bold('/pull')} shows models sized to your GPU`,
        ],
        'warn'
      ),
    ];
  }

  const pick = services.router.pick('orchestrator');
  if (!pick) return out;

  if (!pick.profile.supportsTools) {
    out.push(
      panel(
        'Limited model',
        [
          `${c.bold(pick.model)} has no native tool calling, so nave falls back to a text protocol.`,
          'It works, but it is slower and less reliable.',
          '',
          `${accent('→')} ${c.bold('/models')} shows which of yours do support tools`,
        ],
        'warn'
      )
    );
  }

  const plan = services.router.plan(pick.profile);
  if (!plan.fitsFully) {
    out.push(
      panel(
        'Running partly on CPU',
        [
          `${c.bold(pick.model)} does not fit in available VRAM, so some layers run on the CPU.`,
          'Expect a few tokens per second instead of tens.',
          '',
          `${accent('→')} ${c.bold('/gpu')} shows the arithmetic and what would fit`,
        ],
        'warn'
      )
    );
  }
  return out;
}
