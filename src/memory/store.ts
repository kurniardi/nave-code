import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  unlinkSync,
  statSync,
} from 'node:fs';
import { join, basename } from 'node:path';
import { ensureDir, projectPaths } from '../config/paths.ts';
import {
  parseFrontmatter,
  stringifyFrontmatter,
} from '../util/frontmatter.ts';
import { estimateTokens } from '../util/tokens.ts';

/**
 * Per-project memory.
 *
 * This is the reason nave exists in the shape it does: every project it works
 * on keeps its own durable notes, so a session six weeks from now reaches the
 * same conclusions as the one that made the decision. Memory lives in the
 * project (.nave/memory/*.md), is plain Markdown, and is meant to be committed.
 */

export type MemoryType =
  | 'decision'
  | 'convention'
  | 'architecture'
  | 'gotcha'
  | 'reference'
  | 'glossary'
  | 'todo';

export const MEMORY_TYPES: MemoryType[] = [
  'decision',
  'convention',
  'architecture',
  'gotcha',
  'reference',
  'glossary',
  'todo',
];

export interface MemoryEntry {
  name: string;
  title: string;
  description: string;
  type: MemoryType;
  tags: string[];
  files: string[];
  pinned: boolean;
  created: string;
  updated: string;
  body: string;
  path: string;
}

export interface MemoryWrite {
  name: string;
  title?: string;
  description: string;
  type?: MemoryType;
  tags?: string[];
  files?: string[];
  pinned?: boolean;
  body: string;
}

const INDEX_HEADER = [
  '# Project memory',
  '',
  'Durable notes nave keeps about this project. One file per fact.',
  'Loaded at the start of every nave session — keep it short and true.',
  '',
];

export class MemoryStore {
  readonly dir: string;
  readonly indexPath: string;
  readonly conventionsPath: string;

  constructor(cwd: string) {
    const p = projectPaths(cwd);
    this.dir = p.memory;
    this.indexPath = p.memoryIndex;
    this.conventionsPath = p.conventions;
  }

  get initialised(): boolean {
    return existsSync(this.dir);
  }

  init(): void {
    ensureDir(this.dir);
    if (!existsSync(this.indexPath)) {
      writeFileSync(this.indexPath, INDEX_HEADER.join('\n'), 'utf8');
    }
  }

  list(): MemoryEntry[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')
      .map((f) => this.readFile(join(this.dir, f)))
      .filter((e): e is MemoryEntry => e !== null)
      .sort((a, b) => b.updated.localeCompare(a.updated));
  }

  get(name: string): MemoryEntry | null {
    const file = join(this.dir, `${slug(name)}.md`);
    if (!existsSync(file)) return null;
    return this.readFile(file);
  }

  private readFile(file: string): MemoryEntry | null {
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      return null;
    }
    const { data, body } = parseFrontmatter(raw);
    const name = String(data.name ?? basename(file, '.md'));
    const stat = statSync(file);
    return {
      name,
      title: String(data.title ?? titleize(name)),
      description: String(data.description ?? ''),
      type: (MEMORY_TYPES as string[]).includes(String(data.type))
        ? (data.type as MemoryType)
        : 'reference',
      tags: toArray(data.tags),
      files: toArray(data.files),
      pinned: data.pinned === true,
      created: String(data.created ?? stat.birthtime.toISOString().slice(0, 10)),
      updated: String(data.updated ?? stat.mtime.toISOString().slice(0, 10)),
      body: body.trim(),
      path: file,
    };
  }

  write(entry: MemoryWrite): MemoryEntry {
    this.init();
    const name = slug(entry.name);
    const file = join(this.dir, `${name}.md`);
    const existing = existsSync(file) ? this.readFile(file) : null;
    const today = new Date().toISOString().slice(0, 10);

    const data: Record<string, unknown> = {
      name,
      title: entry.title ?? existing?.title ?? titleize(name),
      description: entry.description,
      type: entry.type ?? existing?.type ?? 'reference',
      created: existing?.created ?? today,
      updated: today,
    };
    const tags = entry.tags ?? existing?.tags ?? [];
    if (tags.length) data.tags = tags;
    const files = entry.files ?? existing?.files ?? [];
    if (files.length) data.files = files;
    if (entry.pinned ?? existing?.pinned) data.pinned = true;

    writeFileSync(
      file,
      stringifyFrontmatter(data, `\n${entry.body.trim()}\n`),
      'utf8'
    );
    this.rebuildIndex();
    return this.readFile(file)!;
  }

  delete(name: string): boolean {
    const file = join(this.dir, `${slug(name)}.md`);
    if (!existsSync(file)) return false;
    unlinkSync(file);
    this.rebuildIndex();
    return true;
  }

  /** The index is derived, never hand-maintained. */
  rebuildIndex(): void {
    this.init();
    const entries = this.list();
    const lines = [...INDEX_HEADER];
    if (!entries.length) {
      lines.push('_No memories yet._', '');
    } else {
      for (const t of MEMORY_TYPES) {
        const group = entries.filter((e) => e.type === t);
        if (!group.length) continue;
        lines.push(`## ${titleize(t)}`, '');
        for (const e of group) {
          const pin = e.pinned ? ' **[pinned]**' : '';
          lines.push(`- [${e.title}](${e.name}.md)${pin} — ${e.description}`);
        }
        lines.push('');
      }
    }
    writeFileSync(this.indexPath, lines.join('\n'), 'utf8');
  }

  /**
   * Keyword recall. Deliberately not embedding-based by default: a local
   * embedding model would compete for the same VRAM as the coding model, and
   * project memories are few enough that lexical scoring is honest and fast.
   */
  search(query: string, limit = 5): MemoryEntry[] {
    const terms = tokenize(query);
    if (!terms.length) return [];
    const scored = this.list().map((e) => {
      const haystacks: Array<[string, number]> = [
        [e.title, 4],
        [e.name, 4],
        [e.description, 3],
        [e.tags.join(' '), 3],
        [e.files.join(' '), 2],
        [e.body, 1],
      ];
      let score = 0;
      for (const [text, weight] of haystacks) {
        const lower = text.toLowerCase();
        for (const term of terms) {
          if (lower.includes(term)) score += weight;
        }
      }
      if (e.pinned) score += 2;
      return { entry: e, score };
    });
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.entry);
  }

  /** Project conventions file (NAVE.md), the equivalent of CLAUDE.md. */
  conventions(): string | null {
    if (!existsSync(this.conventionsPath)) return null;
    try {
      return readFileSync(this.conventionsPath, 'utf8').trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * The block injected into every system prompt: conventions, the index, and
   * any pinned entries in full. Capped so it cannot crowd out a small model.
   */
  contextBlock(maxTokens = 2500): { text: string; tokens: number; entries: number } {
    const parts: string[] = [];
    const conventions = this.conventions();
    if (conventions) {
      parts.push('## Project conventions (NAVE.md)', '', truncateTo(conventions, 1400), '');
    }

    const entries = this.list();
    if (entries.length) {
      parts.push('## Project memory index', '');
      parts.push(
        'These notes were written by earlier nave sessions in this project. ' +
          'Treat them as established context. Read one in full with the ' +
          '`memory` tool (action "read") before contradicting it.',
        ''
      );
      for (const e of entries) {
        parts.push(`- **${e.name}** (${e.type}) — ${e.description}`);
      }
      parts.push('');

      const pinned = entries.filter((e) => e.pinned);
      if (pinned.length) {
        parts.push('## Pinned memory (always applies)', '');
        for (const e of pinned) {
          parts.push(`### ${e.title}`, '', truncateTo(e.body, 700), '');
        }
      }
    }

    let text = parts.join('\n').trim();
    let tokens = estimateTokens(text);
    if (tokens > maxTokens) {
      text = truncateTo(text, maxTokens * 3);
      text += '\n\n_(memory block truncated to fit the context window)_';
      tokens = estimateTokens(text);
    }
    return { text, tokens, entries: entries.length };
  }
}

function toArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string' && v.trim()) {
    return v.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

export function slug(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'note';
}

function titleize(s: string): string {
  return s
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function tokenize(q: string): string[] {
  return q
    .toLowerCase()
    .split(/[^a-z0-9_.]+/)
    .filter((t) => t.length > 2);
}

function truncateTo(s: string, chars: number): string {
  return s.length <= chars ? s : `${s.slice(0, chars)}…`;
}
