import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { userPaths, projectPaths } from '../config/paths.ts';
import { parseFrontmatter } from '../util/frontmatter.ts';
import { ROLES } from '../config/config.ts';
import type { Role } from '../config/config.ts';
import { BUILTIN_AGENTS } from './defs.ts';
import type { AgentDef } from './defs.ts';

/**
 * Custom agents are Markdown files: frontmatter for the wiring, body for the
 * system prompt. Project agents (.nave/agents) shadow user agents (~/.nave/
 * agents), which shadow the built-ins.
 */

const cache = new Map<string, AgentDef[]>();

export function allAgents(cwd: string, force = false): AgentDef[] {
  if (!force && cache.has(cwd)) return cache.get(cwd)!;

  const merged = new Map<string, AgentDef>();
  for (const a of BUILTIN_AGENTS) merged.set(a.name, a);
  for (const dir of [userPaths.agents, projectPaths(cwd).agents]) {
    for (const a of readAgentDir(dir)) merged.set(a.name, a);
  }

  const list = [...merged.values()].sort((a, b) => {
    if (a.name === 'orchestrator') return -1;
    if (b.name === 'orchestrator') return 1;
    return a.name.localeCompare(b.name);
  });
  cache.set(cwd, list);
  return list;
}

export function invalidateAgents(): void {
  cache.clear();
}

export function getAgent(cwd: string, name: string): AgentDef | null {
  const lower = name.toLowerCase();
  return allAgents(cwd).find((a) => a.name.toLowerCase() === lower) ?? null;
}

export function listAgentNames(cwd: string): string[] {
  return allAgents(cwd).map((a) => a.name);
}

/** Compact catalogue for a tool-error message or the system prompt. */
export function describeAgents(cwd: string, exclude: string[] = []): string {
  return allAgents(cwd)
    .filter((a) => !exclude.includes(a.name))
    .map((a) => `- ${a.name}: ${a.description}`)
    .join('\n');
}

function readAgentDir(dir: string): AgentDef[] {
  if (!existsSync(dir)) return [];
  const out: AgentDef[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.md')) continue;
    const full = join(dir, file);
    let raw: string;
    try {
      raw = readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    const { data, body } = parseFrontmatter(raw);
    const name = String(data.name ?? file.replace(/\.md$/, '')).trim();
    if (!name) continue;

    const roleRaw = String(data.role ?? 'code');
    const role: Role = (ROLES as string[]).includes(roleRaw) ? (roleRaw as Role) : 'code';

    out.push({
      name,
      description: String(data.description ?? `Custom agent "${name}"`).replace(/\s+/g, ' ').trim(),
      role,
      tools: parseTools(data.tools),
      systemPrompt: body.trim(),
      model: data.model ? String(data.model) : undefined,
      temperature:
        typeof data.temperature === 'number' ? data.temperature : undefined,
      maxSteps: typeof data.maxSteps === 'number' ? data.maxSteps : undefined,
      source: full,
    });
  }
  return out;
}

function parseTools(v: unknown): string[] | '*' {
  if (v === undefined || v === null || v === '*' || v === 'all') return '*';
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') {
    if (!v.trim()) return '*';
    return v.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return '*';
}

/** Starter file written by `nave agents new`. */
export function agentTemplate(name: string): string {
  return `---
name: ${name}
description: One line on what this agent is for and when to delegate to it.
role: code
model:
tools: [read, write, edit, glob, grep, ls, bash, todo, memory, skill]
temperature: 0.2
---

You are the ${name} agent.

Describe how this agent works: what it reads first, what it must not do, and
what it reports back. Sub-agents cannot ask questions, so be explicit about the
shape of the answer you expect it to produce.
`;
}
