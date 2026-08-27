import type { Tool } from './types.ts';
import type { ToolSpec } from '../providers/types.ts';
import { readTool, writeTool, editTool, lsTool, globTool, grepTool } from './fs.ts';
import { bashTool, bashOutputTool } from './bash.ts';
import { todoTool } from './todo.ts';
import { memoryTool } from './memory.ts';
import { skillTool } from './skill.ts';
import { taskTool } from './task.ts';
import { httpTool } from './http.ts';

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
}): ToolSelection {
  let tools = opts.allow === '*' ? [...ALL_TOOLS] : ALL_TOOLS.filter((t) => opts.allow.includes(t.name));

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

  return { tools, specs: tools.map(toSpec) };
}

export function toSpec(tool: Tool): ToolSpec {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}
