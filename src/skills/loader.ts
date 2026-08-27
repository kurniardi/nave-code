import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename, resolve, sep } from 'node:path';
import { HOME, CLAUDE_USER_DIR } from '../config/paths.ts';
import { parseFrontmatter } from '../util/frontmatter.ts';
import { estimateTokens } from '../util/tokens.ts';

/**
 * Skills are read in place from wherever they already live — by default the
 * user's Claude Code skill library (~/.claude/skills). One library, two
 * clients: nave never forks or copies a skill, so an edit made for one tool is
 * live in the other immediately.
 */

export interface Skill {
  /** Invocation name, namespaced for plugin skills (e.g. "ghost:report"). */
  name: string;
  description: string;
  dir: string;
  file: string;
  source: string;
  allowedTools: string[];
  /** Body is read lazily — 60+ skills would otherwise be a huge upfront read. */
  body?: string;
}

export interface SkillLoadResult {
  skills: Skill[];
  scanned: string[];
  missing: string[];
}

export class SkillLibrary {
  private skills: Skill[] = [];
  private byName = new Map<string, Skill>();
  scanned: string[] = [];
  missing: string[] = [];

  private sources: string[];
  private cwd: string;

  constructor(sources: string[], cwd: string) {
    this.sources = sources;
    this.cwd = cwd;
  }

  load(): SkillLoadResult {
    const seen = new Map<string, Skill>();
    this.scanned = [];
    this.missing = [];

    for (const raw of this.sources) {
      const dir = expand(raw, this.cwd);
      if (!existsSync(dir)) {
        this.missing.push(dir);
        continue;
      }
      this.scanned.push(dir);
      for (const skill of scanDir(dir, dir)) {
        // Later sources override earlier ones by name, so a project skill
        // can shadow a user-level one.
        seen.set(skill.name, skill);
      }
    }

    this.skills = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
    this.byName = new Map(this.skills.map((s) => [s.name, s]));
    return { skills: this.skills, scanned: this.scanned, missing: this.missing };
  }

  get all(): Skill[] {
    return this.skills;
  }

  get count(): number {
    return this.skills.length;
  }

  get(name: string): Skill | null {
    const direct = this.byName.get(name);
    if (direct) return direct;
    const lower = name.toLowerCase();
    return (
      this.skills.find((s) => s.name.toLowerCase() === lower) ??
      this.skills.find((s) => s.name.toLowerCase().endsWith(`:${lower}`)) ??
      null
    );
  }

  /** Full SKILL.md body, read on demand. */
  read(name: string): { skill: Skill; body: string } | null {
    const skill = this.get(name);
    if (!skill) return null;
    if (skill.body === undefined) {
      try {
        const raw = readFileSync(skill.file, 'utf8');
        skill.body = parseFrontmatter(raw).body.trim();
      } catch {
        skill.body = '';
      }
    }
    return { skill, body: skill.body };
  }

  search(query: string, limit = 8): Skill[] {
    const terms = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2);
    if (!terms.length) return this.skills.slice(0, limit);
    return this.skills
      .map((s) => {
        const name = s.name.toLowerCase();
        const desc = s.description.toLowerCase();
        let score = 0;
        for (const t of terms) {
          if (name.includes(t)) score += 3;
          if (desc.includes(t)) score += 1;
        }
        return { s, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.s);
  }

  /**
   * Compact catalogue for the system prompt.
   *
   * A 7B model handed 63 full descriptions loses the plot, so descriptions are
   * clipped to their first sentence and the whole block is token-capped. The
   * `skill` tool remains the way to search and read the rest.
   */
  catalogue(maxSkills: number, maxTokens = 1800): string {
    const lines: string[] = [];
    for (const s of this.skills.slice(0, maxSkills)) {
      lines.push(`- ${s.name}: ${firstSentence(s.description, 130)}`);
    }
    let text = lines.join('\n');
    while (estimateTokens(text) > maxTokens && lines.length > 5) {
      lines.splice(Math.floor(lines.length * 0.8));
      text = lines.join('\n');
    }
    if (lines.length < this.skills.length) {
      text += `\n- …and ${this.skills.length - lines.length} more (use the skill tool with action "search")`;
    }
    return text;
  }
}

function scanDir(dir: string, root: string, depth = 0): Skill[] {
  const out: Skill[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }

  for (const entry of entries) {
    const full = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;

    const skillFile = join(full, 'SKILL.md');
    if (existsSync(skillFile)) {
      const skill = readSkill(skillFile, full, root);
      if (skill) out.push(skill);
      continue;
    }
    // Plugin layout: <root>/<plugin>/<skill>/SKILL.md
    if (depth < 2) out.push(...scanDir(full, root, depth + 1));
  }
  return out;
}

function readSkill(file: string, dir: string, root: string): Skill | null {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const { data } = parseFrontmatter(raw);
  const folder = basename(dir);
  let name = String(data.name ?? folder);

  // Preserve the plugin namespace when the skill sits one level deeper.
  const rel = dir.slice(root.length).split(sep).filter(Boolean);
  if (rel.length > 1 && !name.includes(':')) {
    name = `${rel[rel.length - 2]}:${name}`;
  }

  return {
    name,
    description: String(data.description ?? '').replace(/\s+/g, ' ').trim(),
    dir,
    file,
    source: root,
    allowedTools: Array.isArray(data['allowed-tools'])
      ? (data['allowed-tools'] as string[]).map(String)
      : typeof data['allowed-tools'] === 'string'
        ? String(data['allowed-tools']).split(',').map((s) => s.trim())
        : [],
  };
}

function expand(p: string, cwd: string): string {
  let out = p;
  if (out.startsWith('~')) out = join(HOME, out.slice(1));
  if (out === '$CLAUDE') out = join(CLAUDE_USER_DIR, 'skills');
  return resolve(cwd, out);
}

function firstSentence(s: string, max: number): string {
  const cut = s.split(/(?<=[.!?])\s/)[0] ?? s;
  return cut.length > max ? `${cut.slice(0, max - 1)}…` : cut;
}
