import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PRODUCT, VERSION } from '../version.ts';
import type { Services } from '../core/services.ts';
import type { AgentDef } from '../agents/defs.ts';
import type { ModelProfile } from '../providers/types.ts';
import type { Tool } from '../tools/types.ts';
import type { PermissionMode } from '../config/config.ts';
import { pickShell } from '../tools/bash.ts';
import { describeAgents } from '../agents/loader.ts';
import { estimateTokens } from '../util/tokens.ts';

export interface SystemPromptInput {
  services: Services;
  agent: AgentDef;
  profile: ModelProfile | null;
  tools: Tool[];
  mode: PermissionMode;
  /** Sub-agents get a leaner prompt: no memory index, no agent catalogue. */
  isSubAgent: boolean;
  /** Total prompt budget in tokens; sections are dropped to fit. */
  budgetTokens: number;
  /** Small window: drop the skill catalogue and keep every section terse. */
  tight?: boolean;
}

export function buildSystemPrompt(input: SystemPromptInput): {
  text: string;
  tokens: number;
  dropped: string[];
} {
  const { services, agent, tools, mode } = input;
  const dropped: string[] = [];
  const sections: Array<{ key: string; priority: number; text: string }> = [];

  sections.push({
    key: 'identity',
    priority: 0,
    text: [
      `You are ${PRODUCT} ${VERSION}, a terminal coding agent that runs entirely on this machine ` +
        'through a local Ollama server. There is no cloud service and no API bill; the user paid for ' +
        'the hardware you are running on, so be efficient with steps but do not cut the work short.',
      '',
      agent.systemPrompt,
    ].join('\n'),
  });

  sections.push({
    key: 'environment',
    priority: 1,
    text: ['## Environment', '', environmentBlock(services)].join('\n'),
  });

  sections.push({
    key: 'tools',
    priority: 2,
    text: toolRules(tools, mode),
  });

  if (!input.isSubAgent && services.config.memory.enabled && services.config.memory.autoLoad) {
    const mem = services.memory.contextBlock(Math.floor(input.budgetTokens * (input.tight ? 0.3 : 0.25)));
    if (mem.text) {
      sections.push({ key: 'memory', priority: 3, text: mem.text });
    }
  }

  if (!input.isSubAgent && tools.some((t) => t.name === 'task')) {
    sections.push({
      key: 'agents',
      priority: 5,
      text: [
        '## Sub-agents you can delegate to',
        '',
        describeAgents(services.cwd, [agent.name]),
      ].join('\n'),
    });
  }

  if (services.config.skills.enabled && services.skills.count && tools.some((t) => t.name === 'skill')) {
    const modeCfg = services.config.skills.mode;
    // A catalogue of 60+ skills costs ~1800 tokens. On a small window that is
    // most of the room the conversation needs, so the skill tool carries it.
    const inject =
      modeCfg === 'inject' ||
      (modeCfg === 'auto' && !input.tight && (input.profile?.paramsB ?? 7) >= 7);
    if (inject) {
      sections.push({
        key: 'skills',
        priority: 6,
        text: [
          '## Skills available',
          '',
          'Load one with the skill tool before doing the kind of work it covers.',
          '',
          services.skills.catalogue(services.config.skills.maxInject),
        ].join('\n'),
      });
    } else {
      sections.push({
        key: 'skills',
        priority: 6,
        text:
          `## Skills\n\n${services.skills.count} skills are installed (design, review, testing, ` +
          'thinking frameworks, deployment and more). Before starting a substantial task, call the ' +
          'skill tool with action "search" and a description of the work to see whether one applies.',
      });
    }
  }

  sections.push({
    key: 'style',
    priority: 4,
    text: [
      '## Working style',
      '',
      '- Be concise in what you say to the user; put the detail in the work itself.',
      '- Never claim something works unless you ran it and saw it work. If you did not verify, say so.',
      '- If a tool returns an error, read it and adapt. Do not repeat the same failing call.',
      '- One tool call per step is fine. Do not narrate what you are about to do at length; just do it.',
      '- When you are done, stop calling tools and answer the user directly.',
    ].join('\n'),
  });

  // Assemble, dropping the lowest-priority optional sections if over budget.
  const order = [...sections].sort((a, b) => a.priority - b.priority);
  let chosen = order;
  let text = render(chosen);
  while (estimateTokens(text) > input.budgetTokens && chosen.length > 3) {
    const victim = chosen[chosen.length - 1];
    dropped.push(victim.key);
    chosen = chosen.slice(0, -1);
    text = render(chosen);
  }

  return { text, tokens: estimateTokens(text), dropped };
}

function render(sections: Array<{ text: string }>): string {
  return sections.map((s) => s.text.trim()).join('\n\n');
}

function environmentBlock(services: Services): string {
  const shell = pickShell();
  const lines = [
    `Working directory: ${services.cwd}`,
    `Platform: ${process.platform} (${process.arch}), shell: ${shell.label}`,
    `Today: ${new Date().toISOString().slice(0, 10)}`,
  ];
  const branch = gitBranch(services.cwd);
  if (branch) lines.push(`Git branch: ${branch}`);
  const gpu = services.gpu.gpus[0];
  if (gpu) {
    lines.push(
      `GPU: ${gpu.name} (${Math.round(gpu.totalMb / 1024)} GB${gpu.unified ? ' unified' : ' VRAM'})`
    );
  }
  return lines.map((l) => `- ${l}`).join('\n');
}

function toolRules(tools: Tool[], mode: PermissionMode): string {
  const lines = ['## Tools', ''];
  lines.push(
    'Use tools to act. Do not describe an action you could take with a tool — take it.',
    ''
  );
  for (const t of tools) {
    lines.push(`- **${t.name}** — ${firstLine(t.description)}`);
  }
  lines.push('');
  lines.push('Rules:');
  lines.push('- Read a file before you edit or overwrite it. This is enforced.');
  lines.push(
    '- Call tools through the tool interface. Writing a tool call as text or JSON in your reply does not run it, ' +
      'and claiming you did something you did not do is the worst mistake you can make.'
  );
  lines.push('- Use read, grep, glob and ls for the filesystem; use bash for builds, tests and git.');
  lines.push('- Paths are relative to the working directory. You cannot touch files outside it.');

  if (mode === 'plan') {
    lines.push(
      '- **Plan mode is on: nothing you do may change the machine.** No writes, no edits, no commands. ' +
        'Investigate and then present a plan for the user to approve.'
    );
  } else if (mode === 'ask') {
    lines.push(
      '- Writes, edits and commands need the user\'s approval. If one is declined, do not retry it — ask what they want instead.'
    );
  }
  return lines.join('\n');
}

function firstLine(s: string): string {
  const cut = s.split(/(?<=\.)\s/)[0] ?? s;
  return cut.length > 120 ? `${cut.slice(0, 119)}…` : cut;
}

function gitBranch(cwd: string): string | null {
  const head = join(cwd, '.git', 'HEAD');
  if (!existsSync(head)) return null;
  try {
    const raw = readFileSync(head, 'utf8').trim();
    const m = /^ref: refs\/heads\/(.+)$/.exec(raw);
    return m ? m[1] : `detached at ${raw.slice(0, 8)}`;
  } catch {
    return null;
  }
}
