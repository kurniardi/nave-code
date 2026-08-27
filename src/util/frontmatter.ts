/**
 * Minimal YAML-frontmatter reader/writer.
 *
 * nave stays dependency-free so it can be installed and run on a machine with
 * no network at all. We only need the subset that skills, agents and memory
 * files actually use: scalars, one level of nesting, inline and block lists.
 */

export interface Parsed {
  data: Record<string, unknown>;
  body: string;
}

const FM = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function parseFrontmatter(raw: string): Parsed {
  const m = FM.exec(raw);
  if (!m) return { data: {}, body: raw };
  return { data: parseYamlSubset(m[1]), body: raw.slice(m[0].length) };
}

export function parseYamlSubset(src: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = src.split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) {
      i++;
      continue;
    }
    if (line.length - line.trimStart().length > 0) {
      i++; // orphaned nested line
      continue;
    }
    const kv = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) {
      i++;
      continue;
    }
    const key = kv[1];
    const inline = kv[2].trim();
    i++;

    if (inline) {
      out[key] = coerce(inline);
      continue;
    }

    // Block form: either a list of "- item" entries or a nested map.
    const block: string[] = [];
    while (i < lines.length) {
      const next = lines[i];
      if (!next.trim()) {
        block.push('');
        i++;
        continue;
      }
      if (next.length - next.trimStart().length === 0) break;
      block.push(next);
      i++;
    }
    while (block.length && !block[block.length - 1].trim()) block.pop();

    if (block.length === 0) {
      out[key] = '';
    } else if (block.every((l) => !l.trim() || l.trimStart().startsWith('- '))) {
      out[key] = block
        .filter((l) => l.trim())
        .map((l) => coerce(l.trimStart().slice(2).trim()));
    } else {
      const strip = minIndent(block);
      out[key] = parseYamlSubset(block.map((l) => l.slice(strip)).join('\n'));
    }
  }
  return out;
}

function minIndent(lines: string[]): number {
  let min = Infinity;
  for (const l of lines) {
    if (!l.trim()) continue;
    min = Math.min(min, l.length - l.trimStart().length);
  }
  return Number.isFinite(min) ? min : 0;
}

function coerce(v: string): unknown {
  if (v === '') return '';
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return splitTopLevel(inner).map((s) => coerce(s.trim()));
  }
  const q = v[0];
  if ((q === '"' || q === "'") && v.endsWith(q) && v.length > 1) {
    return v.slice(1, -1);
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^-?\d*\.\d+$/.test(v)) return Number(v);
  return v;
}

function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let buf = '';
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null;
      buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === '[' || ch === '{') depth++;
    if (ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf);
  return parts;
}

/** Serialise a shallow object back to frontmatter + body. */
export function stringifyFrontmatter(
  data: Record<string, unknown>,
  body: string
): string {
  const lines: string[] = ['---'];
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - ${scalar(item)}`);
    } else if (v && typeof v === 'object') {
      lines.push(`${k}:`);
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        lines.push(`  ${k2}: ${scalar(v2)}`);
      }
    } else {
      lines.push(`${k}: ${scalar(v)}`);
    }
  }
  lines.push('---', '');
  return lines.join('\n') + body.replace(/^\n+/, '');
}

const NEEDS_QUOTING = /^\s|\s$|[:#]\s|^[-?>|&*!%@]|\n/;

function scalar(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  const s = String(v);
  return NEEDS_QUOTING.test(s) ? JSON.stringify(s) : s;
}
