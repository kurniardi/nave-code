import type { Services } from '../core/services.ts';
import type { AgentDef } from './defs.ts';
import { getAgent } from './loader.ts';
import { Session } from '../session/session.ts';
import type { Permissions } from '../session/permissions.ts';
import { TodoList } from '../tools/todo.ts';
import { selectTools, getTool } from '../tools/registry.ts';
import type { Tool, ToolContext, ToolResult, AgentSpawnRequest } from '../tools/types.ts';
import { buildSystemPrompt } from '../prompt/system.ts';
import { protocolInstructions, parseProtocol } from '../prompt/protocol.ts';
import type { ChatMessage, ModelProfile, ToolCall } from '../providers/types.ts';
import type { RuntimePlan } from '../gpu/tuning.ts';
import { estimateTokens } from '../util/tokens.ts';
import { contextBudget, tokensToChars } from '../core/budget.ts';
import type { ContextBudget } from '../core/budget.ts';
import type { Asker } from '../ui/choice.ts';

export interface AgentEvents {
  onText?(chunk: string): void;
  onThinking?(chunk: string): void;
  onToolStart?(name: string, args: Record<string, unknown>): void;
  onToolEnd?(name: string, result: ToolResult): void;
  onNotice?(line: string): void;
  onStep?(step: number, max: number): void;
  onModelReady?(info: ModelReadyInfo): void;
  onCompact?(before: number, after: number): void;
}

/** How many times a stalled turn may be prodded before nave gives up. */
const MAX_NUDGES = 2;

export interface ModelReadyInfo {
  agent: string;
  model: string;
  reason: string;
  plan: RuntimePlan;
  toolMode: 'native' | 'prompted';
  tools: string[];
  systemTokens: number;
}

export interface RunOptions {
  services: Services;
  agent: AgentDef;
  session: Session;
  permissions: Permissions;
  events?: AgentEvents;
  signal?: AbortSignal;
  depth?: number;
  modelOverride?: string;
  todos?: TodoList;
  readFiles?: Set<string>;
  /** Sub-agents skip memory injection and the agent catalogue. */
  isSubAgent?: boolean;
  /** Lets tools ask the user a question; absent when non-interactive. */
  ask?: Asker;
}

export interface RunResult {
  text: string;
  steps: number;
  model: string;
  promptTokens: number;
  completionTokens: number;
  toolCalls: number;
  stoppedBecause: 'complete' | 'max_steps' | 'aborted' | 'error';
  error?: string;
  tokensPerSecond: number | null;
}

export class Agent {
  private services: Services;
  private def: AgentDef;
  private session: Session;
  private permissions: Permissions;
  private events: AgentEvents;
  private depth: number;
  private todos: TodoList;
  private readFiles: Set<string>;
  private isSubAgent: boolean;
  private modelOverride?: string;
  private budget: ContextBudget = contextBudget(8192);
  private ask?: Asker;
  /** Rebuilds the system prompt when the permission mode changes mid-turn. */
  private refreshSystem: (() => void) | null = null;

  constructor(opts: RunOptions) {
    this.services = opts.services;
    this.def = opts.agent;
    this.session = opts.session;
    this.permissions = opts.permissions;
    this.events = opts.events ?? {};
    this.depth = opts.depth ?? 0;
    this.todos = opts.todos ?? new TodoList();
    this.readFiles = opts.readFiles ?? new Set();
    this.isSubAgent = opts.isSubAgent ?? false;
    this.modelOverride = opts.modelOverride;
    this.ask = opts.ask;
  }

  async run(userMessage: string | null, signal: AbortSignal): Promise<RunResult> {
    const { services } = this;

    // 1. Model choice.
    const pinned = this.modelOverride ?? this.def.model;
    let profile: ModelProfile | null = null;
    let model: string;
    let reason: string;

    if (pinned) {
      profile = services.router.get(pinned);
      model = profile?.name ?? pinned;
      reason = this.modelOverride ? 'requested for this run' : `pinned by the ${this.def.name} agent`;
      if (!profile) {
        return this.errorResult(
          model,
          `Model "${pinned}" is not installed. Pull it with "nave pull ${pinned}", or run "nave models" to see what is available.`
        );
      }
    } else {
      const choice = services.router.pick(this.def.role);
      if (!choice) {
        return this.errorResult(
          '(none)',
          'No usable Ollama model is installed. Run "nave doctor" for recommendations sized to your GPU.'
        );
      }
      profile = choice.profile;
      model = choice.model;
      reason = choice.reason;
    }

    // 2. GPU-fitted runtime plan.
    const plan = services.router.plan(profile);
    for (const note of plan.notes) this.events.onNotice?.(note);

    // 3. Budgets, then tools sized to them.
    const budget = contextBudget(plan.numCtx, services.config.ui.compactAtPercent);
    this.budget = budget;

    // Recomputed whenever the permission mode changes: plan mode withholds
    // every mutating tool, so approving a plan has to hand them back — within
    // the same turn, or the model is told to build something it cannot touch.
    const pickTools = () =>
      selectTools({
        allow: this.def.tools,
        paramsB: profile.paramsB,
        hasSkills: services.skills.count > 0,
        memoryEnabled: services.config.memory.enabled,
        canDelegate: this.depth < services.config.agents.maxDepth && !this.isSubAgent,
        compact: budget.tight,
        planMode: this.permissions.currentMode === 'plan',
        interactive: this.ask !== undefined,
      });
    let selection = pickTools();
    const toolMode: 'native' | 'prompted' = profile.supportsTools ? 'native' : 'prompted';

    // 4. System prompt, capped so the conversation still has room.
    const built = buildSystemPrompt({
      services,
      agent: this.def,
      profile,
      tools: selection.tools,
      mode: this.permissions.currentMode,
      isSubAgent: this.isSubAgent,
      budgetTokens: budget.system,
      tight: budget.tight,
    });
    const compose = (): string => {
      const rebuilt = buildSystemPrompt({
        services,
        agent: this.def,
        profile,
        tools: selection.tools,
        mode: this.permissions.currentMode,
        isSubAgent: this.isSubAgent,
        budgetTokens: budget.system,
        tight: budget.tight,
      });
      return toolMode === 'prompted'
        ? `${rebuilt.text}\n\n${protocolInstructions(selection.specs)}`
        : rebuilt.text;
    };

    let systemText = built.text;
    if (toolMode === 'prompted') {
      systemText += `\n\n${protocolInstructions(selection.specs)}`;
    }
    this.session.setSystem(systemText);
    this.session.model = model;
    this.refreshSystem = () => this.session.setSystem(compose());

    if (built.dropped.length) {
      this.events.onNotice?.(
        `context is tight — dropped ${built.dropped.join(', ')} from the system prompt`
      );
    }

    this.events.onModelReady?.({
      agent: this.def.name,
      model,
      reason,
      plan,
      toolMode,
      tools: selection.tools.map((t) => t.name),
      systemTokens: estimateTokens(systemText),
    });

    if (userMessage) this.session.add({ role: 'user', content: userMessage });

    // 5. The loop.
    const maxSteps = this.def.maxSteps ?? services.config.agents.maxSteps;
    const compactAt = budget.compactAt;
    let steps = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let toolCalls = 0;
    let lastText = '';
    let tps: number | null = null;
    let nudges = 0;

    const options = {
      ...plan.options,
      ...(this.def.temperature !== undefined ? { temperature: this.def.temperature } : {}),
    };

    while (steps < maxSteps) {
      if (signal.aborted) {
        return this.result(lastText, steps, model, promptTokens, completionTokens, toolCalls, 'aborted', tps);
      }
      steps++;
      this.events.onStep?.(steps, maxSteps);

      const compacted = await this.session.compact(services, compactAt);
      if (compacted) {
        this.events.onCompact?.(compacted.before, compacted.after);
      }

      let res;
      try {
        res = await services.client.chat(
          {
            model,
            messages: this.session.messages,
            tools: toolMode === 'native' ? selection.specs : undefined,
            // Be explicit, and ask for it. Omitting this lets the model
            // decide; think:false does not stop a qwen3-class model reasoning,
            // it only moves the reasoning out of the thinking field and into
            // content, where it lands in the answer and the transcript. Asking
            // for it keeps content clean. ui.showThinking decides whether the
            // user sees it, and history drops it, so the window is not spent
            // on it twice.
            think: profile.supportsThinking ? true : undefined,
            options,
            signal,
          },
          (delta) => {
            if (delta.content) this.events.onText?.(delta.content);
            if (delta.thinking) this.events.onThinking?.(delta.thinking);
          }
        );
      } catch (err) {
        if (signal.aborted) {
          return this.result(lastText, steps, model, promptTokens, completionTokens, toolCalls, 'aborted', tps);
        }
        return this.errorResult(model, (err as Error).message, steps);
      }

      promptTokens += res.promptTokens;
      completionTokens += res.completionTokens;
      if (res.tokensPerSecond) tps = res.tokensPerSecond;

      let calls: ToolCall[] = res.message.tool_calls ?? [];
      let assistantText = res.message.content;
      let calledInText = false;

      if (!calls.length) {
        // Even tool-capable local models sometimes print a JSON tool call as
        // text instead of emitting it through the tool channel, then claim the
        // call succeeded. Recover it — but only when the name matches a tool
        // this agent actually has, so real JSON in an answer is left alone.
        const parsed = parseProtocol(assistantText);
        const known = parsed.calls.filter((call) =>
          selection.tools.some((t) => t.name === call.function.name)
        );
        if (known.length) {
          calls = known;
          assistantText = parsed.text;
          calledInText = toolMode === 'native';
          if (calledInText) {
            this.events.onNotice?.(
              'the model wrote a tool call as text instead of calling it — recovered'
            );
          }
        }
      }

      const assistantMsg: ChatMessage = { role: 'assistant', content: assistantText };
      if (res.message.thinking) assistantMsg.thinking = res.message.thinking;
      if (calls.length && toolMode === 'native') assistantMsg.tool_calls = calls;
      this.session.add(assistantMsg);

      if (!calls.length) {
        lastText = assistantText.trim();

        // Small models often narrate the next step instead of taking it —
        // "I will now edit the file" — and then stop. An unfinished plan is a
        // reliable, language-independent signal that they are not actually
        // done, so nudge once or twice rather than ending the turn.
        const unfinished = this.todos.all.filter((t) => t.status !== 'done');
        if (unfinished.length && nudges < MAX_NUDGES) {
          nudges++;
          this.events.onNotice?.(
            `the plan still has ${unfinished.length} step(s) open — asking it to continue`
          );
          this.session.add({
            role: 'user',
            content:
              `You stopped without calling a tool, but the plan is not finished. Still open:\n` +
              unfinished.map((t) => `- ${t.content}`).join('\n') +
              `\n\nDo the next step now by calling the tool that does it. ` +
              `Do not describe what you are about to do — do it. ` +
              `If a step turns out to be unnecessary or impossible, mark it done with the todo tool and say why.`,
          });
          continue;
        }

        return this.result(lastText, steps, model, promptTokens, completionTokens, toolCalls, 'complete', tps);
      }

      if (assistantText.trim()) lastText = assistantText.trim();
      toolCalls += calls.length;

      const modeBefore = this.permissions.currentMode;
      const results = await this.executeCalls(calls, selection.tools, signal);
      if (this.permissions.currentMode !== modeBefore) {
        // Approving a plan changes both what the model may do and what it is
        // told; the tool set and the instructions have to move together.
        selection = pickTools();
        this.refreshSystem?.();
        this.events.onNotice?.(
          `tools available: ${selection.tools.map((t) => t.name).join(', ')}`
        );
      }
      for (const { call, result } of results) {
        this.session.add({
          role: toolMode === 'native' ? 'tool' : 'user',
          tool_name: toolMode === 'native' ? call.function.name : undefined,
          content:
            toolMode === 'native'
              ? clip(result.content, budget.toolResult)
              : `[Result of ${call.function.name}]\n${clip(result.content, budget.toolResult)}`,
        });
      }
    }

    return this.result(lastText, steps, model, promptTokens, completionTokens, toolCalls, 'max_steps', tps);
  }

  private async executeCalls(
    calls: ToolCall[],
    available: Tool[],
    signal: AbortSignal
  ): Promise<Array<{ call: ToolCall; result: ToolResult }>> {
    const byName = new Map(available.map((t) => [t.name, t]));
    const ctx = this.toolContext(signal);

    const runOne = async (call: ToolCall) => {
      const name = call.function.name;
      const tool = byName.get(name) ?? getTool(name);
      if (!tool) {
        return {
          call,
          result: {
            ok: false,
            content: `Error: no tool named "${name}". Available: ${[...byName.keys()].join(', ')}.`,
          } satisfies ToolResult,
        };
      }
      if (!byName.has(tool.name)) {
        return {
          call,
          result: {
            ok: false,
            content: `Error: the ${tool.name} tool is not available to the ${this.def.name} agent.`,
          } satisfies ToolResult,
        };
      }

      this.events.onToolStart?.(tool.name, call.function.arguments);
      let result: ToolResult;
      try {
        result = await tool.run(call.function.arguments, ctx);
      } catch (err) {
        result = {
          ok: false,
          content: `Error: the ${tool.name} tool threw: ${(err as Error).message}`,
        };
      }
      this.events.onToolEnd?.(tool.name, result);
      return { call, result };
    };

    // Read-only calls are independent, so they can overlap. Anything that
    // writes runs one at a time and in order.
    const allReadOnly = calls.every((c) => (byName.get(c.function.name) ?? getTool(c.function.name))?.readOnly);
    if (allReadOnly && calls.length > 1) {
      const limit = this.services.config.agents.maxParallel;
      const out: Array<{ call: ToolCall; result: ToolResult }> = [];
      for (let i = 0; i < calls.length; i += limit) {
        out.push(...(await Promise.all(calls.slice(i, i + limit).map(runOne))));
      }
      return out;
    }

    const out: Array<{ call: ToolCall; result: ToolResult }> = [];
    for (const call of calls) {
      out.push(await runOne(call));
      if (signal.aborted) break;
    }
    return out;
  }

  private toolContext(signal: AbortSignal): ToolContext {
    return {
      services: this.services,
      cwd: this.services.cwd,
      permissions: this.permissions,
      todos: this.todos,
      signal,
      depth: this.depth,
      emit: (line) => this.events.onNotice?.(line),
      readFiles: this.readFiles,
      resultTokens: this.budget.toolResult,
      ask: this.ask,
      spawnAgent: (req) => this.spawnSubAgent(req, signal),
    };
  }

  private async spawnSubAgent(req: AgentSpawnRequest, signal: AbortSignal): Promise<string> {
    const def = getAgent(this.services.cwd, req.agent);
    if (!def) throw new Error(`unknown agent "${req.agent}"`);

    const sub = new Session(this.services.cwd, `${this.session.id}-${req.agent}-${Date.now() % 100000}`);
    const agent = new Agent({
      services: this.services,
      agent: def,
      session: sub,
      permissions: this.permissions,
      depth: this.depth + 1,
      modelOverride: req.model,
      isSubAgent: true,
      readFiles: new Set(this.readFiles),
      ask: this.ask,
      events: {
        onNotice: (line) => this.events.onNotice?.(`  ${req.agent}: ${line}`),
        onToolStart: (name, args) => this.events.onToolStart?.(`${req.agent}/${name}`, args),
        onToolEnd: (name, result) => this.events.onToolEnd?.(`${req.agent}/${name}`, result),
        onModelReady: (info) =>
          this.events.onNotice?.(`  ${req.agent} running on ${info.model} (${info.plan.numCtx} ctx)`),
      },
    });

    const prompt = req.context ? `${req.context}\n\n---\n\n${req.prompt}` : req.prompt;
    const result = await agent.run(prompt, signal);

    // Anything the sub-agent read counts as read for the parent too.
    for (const f of agent.readFiles) this.readFiles.add(f);

    if (result.stoppedBecause === 'error') {
      throw new Error(result.error ?? 'unknown error');
    }
    if (result.stoppedBecause === 'max_steps') {
      return `${result.text}\n\n[The ${req.agent} sub-agent hit its step limit; this report may be incomplete.]`;
    }
    return result.text || '(the sub-agent returned nothing)';
  }

  private result(
    text: string,
    steps: number,
    model: string,
    promptTokens: number,
    completionTokens: number,
    toolCalls: number,
    stoppedBecause: RunResult['stoppedBecause'],
    tokensPerSecond: number | null
  ): RunResult {
    return { text, steps, model, promptTokens, completionTokens, toolCalls, stoppedBecause, tokensPerSecond };
  }

  private errorResult(model: string, error: string, steps = 0): RunResult {
    return {
      text: '',
      steps,
      model,
      promptTokens: 0,
      completionTokens: 0,
      toolCalls: 0,
      stoppedBecause: 'error',
      error,
      tokensPerSecond: null,
    };
  }
}

/** Keep the head and tail of an oversized tool result; the middle rarely matters. */
function clip(s: string, maxTokens: number): string {
  const max = tokensToChars(maxTokens);
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.7);
  return (
    `${s.slice(0, head)}

… [${s.length - max} characters trimmed to fit the context window; ` +
    `narrow the search or read a smaller range] …

` +
    s.slice(s.length - (max - head))
  );
}
