import type { Tool } from './types.ts';
import type { ToolSpec, JsonSchema } from '../providers/types.ts';
import { readTool, writeTool, editTool, lsTool, globTool, grepTool } from './fs.ts';
import { bashTool, bashOutputTool } from './bash.ts';
import { todoTool } from './todo.ts';
import { memoryTool } from './memory.ts';
import { skillTool } from './skill.ts';
import { taskTool } from './task.ts';
import { httpTool } from './http.ts';
import { presentPlanTool } from './plan.ts';

export const ALL_TOOLS: Tool[] = [
  readTool,
  writeTool,
  editTool,
  globTool,
  grepTool,
  lsTool,
  bashTool,
  bashOutputTool,
  todoTool,
  memoryTool,
  skillTool,
  taskTool,
  httpTool,
  presentPlanTool,
];

const BY_NAME = new Map(ALL_TOOLS.map((t) => [t.name, t]));

export function getTool(name: string): Tool | null {
  return BY_NAME.get(name) ?? BY_NAME.get(name.toLowerCase()) ?? null;
}

export interface ToolSelection {
  tools: Tool[];
  specs: ToolSpec[];
}

/**
 * Choose the tool set for one agent.
 *
 * Small local models degrade quickly as the tool list grows, so this trims:
 * a model under ~4B parameters gets the core set only, and any agent can pin
 * its own list.
 */
export function selectTools(opts: {
  allow: string[] | '*';
  paramsB: number | null;
  hasSkills: boolean;
  memoryEnabled: boolean;
  canDelegate: boolean;
  /** When true, descriptions are trimmed to fit a small context window. */
  compact?: boolean;
  /** Plan mode offers present_plan and withholds everything that mutates. */
  planMode?: boolean;
  /** No one to answer questions, so plan approval is impossible. */
  interactive?: boolean;
}): ToolSelection {
  let tools = opts.allow === '*' ? [...ALL_TOOLS] : ALL_TOOLS.filter((t) => opts.allow.includes(t.name));

  // present_plan exists only to leave plan mode, and needs someone to ask.
  if (!opts.planMode || opts.interactive === false) {
    tools = tools.filter((t) => t.name !== 'present_plan');
  }
  if (opts.planMode) tools = tools.filter((t) => t.readOnly || t.name === 'present_plan');
  if (!opts.hasSkills) tools = tools.filter((t) => t.name !== 'skill');
  if (!opts.memoryEnabled) tools = tools.filter((t) => t.name !== 'memory');
  if (!opts.canDelegate) tools = tools.filter((t) => t.name !== 'task');

  const small = (opts.paramsB ?? 7) < 4;
  if (small && opts.allow === '*') {
    const core = new Set(['read', 'write', 'edit', 'glob', 'grep', 'ls', 'bash', 'todo']);
    tools = tools.filter((t) => core.has(t.name));
  } else {
    tools = tools.filter((t) => !t.advanced || opts.allow !== '*');
  }

  // On a tight window the schemas are the single biggest fixed cost, and
  // bash_readonly duplicates what bash already does.
  if (opts.compact && opts.allow === '*') {
    tools = tools.filter((t) => t.name !== 'bash_readonly' && t.name !== 'http');
  }

  return { tools, specs: tools.map((t) => toSpec(t, opts.compact)) };
}

export function toSpec(tool: Tool, compact = false): ToolSpec {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: compact ? firstSentence(tool.description, 150) : tool.description,
      parameters: compact ? compactSchema(tool.parameters) : tool.parameters,
    },
  };
}

/** Keep the shape and the required fields; shorten the prose. */
function compactSchema(schema: JsonSchema): JsonSchema {
  if (!schema.properties) return schema;
  const properties: Record<string, JsonSchema> = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    properties[key] = {
      ...prop,
      description: prop.description ? firstSentence(prop.description, 70) : undefined,
      ...(prop.properties ? compactSchema(prop) : {}),
    };
  }
  return { ...schema, description: undefined, properties };
}

function firstSentence(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const cut = flat.split(/(?<=\.)\s/)[0] ?? flat;
  const chosen = cut.length < 25 ? flat : cut;
  return chosen.length > max ? `${chosen.slice(0, max - 1)}…` : chosen;
}
