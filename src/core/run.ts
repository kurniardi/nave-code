import { Agent } from '../agents/agent.ts';
import type { RunResult } from '../agents/agent.ts';
import { getAgent } from '../agents/loader.ts';
import type { Services } from './services.ts';
import type { Session } from '../session/session.ts';
import type { Permissions } from '../session/permissions.ts';
import { TodoList } from '../tools/todo.ts';
import type { Asker } from '../ui/choice.ts';
import { Spinner, StreamWriter, toolLine, resultLine, noticeLine } from '../ui/render.ts';
import { c, accent, muted } from '../util/colors.ts';
import { formatTokens } from '../util/tokens.ts';

export interface TurnDeps {
  services: Services;
  session: Session;
  permissions: Permissions;
  todos: TodoList;
  readFiles: Set<string>;
  agentName: string;
  modelOverride?: string;
  /** Print only the final answer (headless mode). */
  quiet?: boolean;
  /** In headless mode, still show tool activity — on stderr, so stdout pipes clean. */
  verbose?: boolean;
  /** Show the model/plan line on the first turn. */
  announceModel?: boolean;
  /** Lets tools ask the user a question; absent in headless runs. */
  ask?: Asker;
}

/**
 * One user turn: run the agent and render it to the terminal.
 * Shared by the REPL and the one-shot `-p` path so they behave identically.
 */
export async function executeTurn(
  prompt: string,
  deps: TurnDeps,
  signal: AbortSignal
): Promise<RunResult> {
  const def = getAgent(deps.services.cwd, deps.agentName);
  if (!def) {
    return {
      text: '',
      steps: 0,
      model: '(none)',
      promptTokens: 0,
      completionTokens: 0,
      toolCalls: 0,
      stoppedBecause: 'error',
      error: `unknown agent "${deps.agentName}"`,
      tokensPerSecond: null,
    };
  }

  const spinner = new Spinner();
  let writer = new StreamWriter();
  let streaming = false;
  let thinkingShown = false;

  // Where progress chatter goes. In headless mode it must never touch stdout,
  // which belongs to the answer.
  const chatter: ((s: string) => void) | null = deps.quiet
    ? deps.verbose
      ? (s) => process.stderr.write(s)
      : null
    : (s) => process.stdout.write(s);

  const stopStream = () => {
    if (streaming) {
      writer.flush();
      streaming = false;
      writer = new StreamWriter();
    }
  };

  const agent = new Agent({
    services: deps.services,
    agent: def,
    session: deps.session,
    permissions: deps.permissions,
    todos: deps.todos,
    readFiles: deps.readFiles,
    modelOverride: deps.modelOverride,
    ask: deps.ask,
    events: {
      onModelReady: (info) => {
        if (deps.quiet || !deps.announceModel) return;
        const fit = info.plan.fitsFully ? c.green('GPU') : c.yellow('GPU+CPU');
        process.stdout.write(
          muted(
            `  ${info.agent} · ${c.bold(info.model)} · ${formatTokens(info.plan.numCtx)} ctx · ${fit} · ` +
              `${info.toolMode === 'native' ? 'native tools' : 'prompted tools'} · ${info.tools.length} tools\n`
          ) + muted(`  ${info.reason}\n\n`)
        );
      },
      onText: (chunk) => {
        // Headless mode buffers instead: only the final answer goes to stdout,
        // so `nave -p` is safe to pipe.
        if (deps.quiet) return;
        if (!streaming) {
          spinner.stop();
          streaming = true;
        }
        writer.write(chunk);
      },
      onThinking: (chunk) => {
        if (deps.quiet || !deps.services.config.ui.showThinking) return;
        if (!thinkingShown) {
          spinner.stop();
          process.stdout.write(muted('  thinking…\n'));
          thinkingShown = true;
        }
        process.stdout.write(muted(chunk));
      },
      onToolStart: (name, args) => {
        if (!chatter) return;
        stopStream();
        spinner.stop();
        chatter(`${toolLine(name, args)}\n`);
        if (!deps.quiet) spinner.start(`${name}…`);
      },
      onToolEnd: (_name, result) => {
        spinner.stop();
        if (!chatter) return;
        chatter(`${resultLine(result)}\n`);
        if (!deps.quiet) spinner.start('thinking…');
      },
      onNotice: (line) => {
        if (!chatter) return;
        stopStream();
        spinner.stop();
        chatter(`${noticeLine(line)}\n`);
        if (!deps.quiet) spinner.start('thinking…');
      },
      onStep: (step) => {
        if (deps.quiet) return;
        spinner.start(step === 1 ? 'thinking…' : `thinking… (step ${step})`);
      },
      onCompact: (before, after) => {
        if (deps.quiet) return;
        spinner.stop();
        process.stdout.write(
          noticeLine(`context was full — compacted ${formatTokens(before)} → ${formatTokens(after)} tokens`) + '\n'
        );
      },
    },
  });

  if (!deps.quiet) spinner.start('thinking…');
  let result: RunResult;
  try {
    result = await agent.run(prompt, signal);
  } finally {
    spinner.stop();
    stopStream();
  }

  if (deps.quiet && result.text) {
    process.stdout.write(`${result.text}\n`);
  }

  if (!deps.quiet && result.stoppedBecause === 'max_steps') {
    process.stdout.write(
      `\n${c.yellow('⚠')} ${muted(`stopped after ${result.steps} steps — the task may be unfinished. Say "continue" to resume.`)}\n`
    );
  }
  if (!deps.quiet && result.stoppedBecause === 'aborted') {
    process.stdout.write(`\n${muted('interrupted')}\n`);
  }

  return result;
}

export function newTodos(): TodoList {
  return new TodoList();
}

export function summariseTurn(result: RunResult): string {
  const bits: string[] = [];
  if (result.toolCalls) bits.push(`${result.toolCalls} tool call${result.toolCalls === 1 ? '' : 's'}`);
  bits.push(`${formatTokens(result.completionTokens)} generated`);
  if (result.tokensPerSecond) bits.push(`${result.tokensPerSecond.toFixed(1)} tok/s`);
  return muted(`  ${accent('·')} ${bits.join(' · ')}`);
}
