import { homedir } from 'node:os';
import { join, resolve, isAbsolute, relative, sep } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

export const HOME = homedir();

/** ~/.nave — user-level config, agents, skills, model cache. */
export const USER_DIR = process.env.NAVE_HOME
  ? resolve(process.env.NAVE_HOME)
  : join(HOME, '.nave');

/** Additional user skill directory. nave reads it in place, never copies. */
export const CLAUDE_USER_DIR = join(HOME, '.claude');

export const userPaths = {
  root: USER_DIR,
  config: join(USER_DIR, 'config.json'),
  agents: join(USER_DIR, 'agents'),
  skills: join(USER_DIR, 'skills'),
  commands: join(USER_DIR, 'commands'),
  cache: join(USER_DIR, 'cache'),
  modelCache: join(USER_DIR, 'cache', 'models.json'),
  logs: join(USER_DIR, 'logs'),
};

/** .nave inside whichever project nave is working on. */
export function projectPaths(cwd: string) {
  const root = join(cwd, '.nave');
  return {
    root,
    config: join(root, 'config.json'),
    memory: join(root, 'memory'),
    memoryIndex: join(root, 'memory', 'MEMORY.md'),
    agents: join(root, 'agents'),
    skills: join(root, 'skills'),
    commands: join(root, 'commands'),
    sessions: join(root, 'sessions'),
    cache: join(root, 'cache'),
    conventions: join(cwd, 'NAVE.md'),
  };
}

export function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** Resolve a user-supplied path against cwd and keep it inside the project. */
export function resolveInProject(
  cwd: string,
  p: string
): { path: string; inside: boolean } {
  const abs = isAbsolute(p) ? resolve(p) : resolve(cwd, p);
  const rel = relative(resolve(cwd), abs);
  const inside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  return { path: abs, inside };
}

export function displayPath(cwd: string, abs: string): string {
  const rel = relative(cwd, abs);
  if (!rel) return '.';
  if (!rel.startsWith('..')) return rel.split(sep).join('/');
  return abs;
}
