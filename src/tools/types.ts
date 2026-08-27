import type { Services } from '../core/services.ts';
import type { JsonSchema } from '../providers/types.ts';
import type { Permissions } from '../session/permissions.ts';
import type { TodoList } from './todo.ts';

export interface ToolResult {
  ok: boolean;
  /** Text handed back to the model. */
  content: string;
  /** Optional one-line summary for the terminal. */
  display?: string;
  meta?: Record<string, unknown>;
}

export interface AgentSpawnRequest {
  agent: string;
  prompt: string;
  model?: string;
  context?: string;
}

export interface ToolContext {
  services: Services;
  cwd: string;
  permissions: Permissions;
  todos: TodoList;
  signal: AbortSignal;
  depth: number;
  /** Emit progress for the terminal; nested agents indent automatically. */
  emit: (line: string) => void;
  /** Injected by the agent runtime so the task tool can start sub-agents. */
  spawnAgent?: (req: AgentSpawnRequest) => Promise<string>;
  /** Files the model has read this session; write/edit require a prior read. */
  readFiles: Set<string>;
}

export interface Tool {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** Read-only tools are auto-approved and may run in parallel. */
  readOnly: boolean;
  /** Hide from models that are weak at large tool sets. */
  advanced?: boolean;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export function ok(content: string, display?: string, meta?: Record<string, unknown>): ToolResult {
  return { ok: true, content, display, meta };
}

export function fail(content: string, display?: string): ToolResult {
  return { ok: false, content: `Error: ${content}`, display: display ?? content };
}

export function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' ? v : v === undefined || v === null ? undefined : String(v);
}

export function num(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) {
    return Number(v);
  }
  return undefined;
}

export function bool(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key];
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    if (/^(true|yes|1)$/i.test(v)) return true;
    if (/^(false|no|0)$/i.test(v)) return false;
  }
  return undefined;
}
