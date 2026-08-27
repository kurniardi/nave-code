import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { userPaths, projectPaths, ensureDir } from './paths.ts';

/** The jobs nave routes to different local models. */
export type Role =
  | 'orchestrator'
  | 'code'
  | 'plan'
  | 'review'
  | 'explore'
  | 'summarize'
  | 'fast'
  | 'vision'
  | 'embed';

export const ROLES: Role[] = [
  'orchestrator',
  'code',
  'plan',
  'review',
  'explore',
  'summarize',
  'fast',
  'vision',
  'embed',
];

export type PermissionMode = 'ask' | 'acceptEdits' | 'plan' | 'full';

export interface NaveConfig {
  ollama: {
    host: string;
    keepAlive: string;
    requestTimeoutMs: number;
    numParallel: number;
  };
  models: Partial<Record<Role, string>> & { default?: string };
  sampling: {
    temperature: number;
    topP: number;
    repeatPenalty: number;
    seed?: number;
  };
  gpu: {
    autoTune: boolean;
    reserveMb: number;
    vramBudgetMb: number | null;
    maxContext: number;
    minContext: number;
    flashAttention: boolean;
    kvCacheType: 'f16' | 'q8_0' | 'q4_0';
    allowCpuOffload: boolean;
  };
  memory: {
    enabled: boolean;
    autoLoad: boolean;
    maxIndexEntries: number;
    suggestOnExit: boolean;
  };
  skills: {
    enabled: boolean;
    sources: string[];
    mode: 'auto' | 'inject' | 'tool' | 'off';
    maxInject: number;
  };
  permissions: {
    mode: PermissionMode;
    allow: string[];
    deny: string[];
  };
  agents: {
    maxDepth: number;
    maxParallel: number;
    maxSteps: number;
  };
  ui: {
    color: boolean | 'auto';
    showThinking: boolean;
    compactAtPercent: number;
    streamOutput: boolean;
  };
}

export const DEFAULT_CONFIG: NaveConfig = {
  ollama: {
    host: 'http://127.0.0.1:11434',
    keepAlive: '15m',
    requestTimeoutMs: 600_000,
    numParallel: 1,
  },
  models: {},
  sampling: {
    temperature: 0.2,
    topP: 0.9,
    repeatPenalty: 1.05,
  },
  gpu: {
    autoTune: true,
    reserveMb: 700,
    vramBudgetMb: null,
    maxContext: 32768,
    minContext: 4096,
    flashAttention: true,
    kvCacheType: 'q8_0',
    allowCpuOffload: true,
  },
  memory: {
    enabled: true,
    autoLoad: true,
    maxIndexEntries: 60,
    suggestOnExit: true,
  },
  skills: {
    enabled: true,
    // Claude Code's user skills are read in place — one library, two clients.
    sources: ['~/.claude/skills', '~/.nave/skills', '.nave/skills'],
    mode: 'auto',
    maxInject: 80,
  },
  permissions: {
    mode: 'ask',
    allow: [],
    deny: ['Bash(rm -rf /*)', 'Bash(mkfs*)', 'Bash(:(){:|:&};:)'],
  },
  agents: {
    maxDepth: 3,
    maxParallel: 2,
    maxSteps: 60,
  },
  ui: {
    color: 'auto',
    showThinking: false,
    compactAtPercent: 80,
    streamOutput: true,
  },
};

export interface LoadedConfig {
  config: NaveConfig;
  sources: string[];
  cwd: string;
}

export function loadConfig(cwd: string): LoadedConfig {
  const sources: string[] = [];
  let cfg = structuredClone(DEFAULT_CONFIG);

  for (const file of [userPaths.config, projectPaths(cwd).config]) {
    const patch = readJson(file);
    if (patch) {
      cfg = deepMerge(cfg, patch) as NaveConfig;
      sources.push(file);
    }
  }

  // Env overrides win over files so a single run can be redirected.
  if (process.env.OLLAMA_HOST) {
    cfg.ollama.host = normaliseHost(process.env.OLLAMA_HOST);
    sources.push('env:OLLAMA_HOST');
  }
  if (process.env.NAVE_MODEL) {
    cfg.models.default = process.env.NAVE_MODEL;
    sources.push('env:NAVE_MODEL');
  }
  return { config: cfg, sources, cwd };
}

export function normaliseHost(host: string): string {
  let h = host.trim();
  if (!/^https?:\/\//.test(h)) h = `http://${h}`;
  return h.replace(/\/+$/, '');
}

export function saveConfig(
  file: string,
  patch: Record<string, unknown>
): void {
  const current = readJson(file) ?? {};
  const next = deepMerge(current, patch);
  ensureDir(dirname(file));
  writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8');
}

function readJson(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    process.emitWarning(`nave: ignoring malformed config at ${file}`);
    return null;
  }
}

export function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(patch)) return patch as unknown as T;
  if (typeof patch !== 'object' || typeof base !== 'object' || base === null) {
    return patch as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    out[k] = deepMerge((base as Record<string, unknown>)[k], v);
  }
  return out as T;
}

/** Read a dotted path like "gpu.maxContext" out of the config. */
export function getPath(obj: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (acc, k) =>
        acc && typeof acc === 'object'
          ? (acc as Record<string, unknown>)[k]
          : undefined,
      obj
    );
}

/** Build the nested patch object for a dotted path. */
export function setPath(path: string, value: unknown): Record<string, unknown> {
  const keys = path.split('.');
  const root: Record<string, unknown> = {};
  let node = root;
  for (let i = 0; i < keys.length - 1; i++) {
    node[keys[i]] = {};
    node = node[keys[i]] as Record<string, unknown>;
  }
  node[keys[keys.length - 1]] = value;
  return root;
}

/** Coerce a CLI string into the type the existing config value implies. */
export function coerceConfigValue(current: unknown, raw: string): unknown {
  if (typeof current === 'number') {
    const n = Number(raw);
    if (Number.isNaN(n)) throw new Error(`expected a number, got "${raw}"`);
    return n;
  }
  if (typeof current === 'boolean') {
    if (/^(true|yes|on|1)$/i.test(raw)) return true;
    if (/^(false|no|off|0)$/i.test(raw)) return false;
    throw new Error(`expected a boolean, got "${raw}"`);
  }
  if (Array.isArray(current)) {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return raw;
}
