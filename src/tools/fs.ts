import {
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  readdirSync,
  mkdirSync,
} from 'node:fs';
import { join, dirname, relative, sep, extname } from 'node:path';
import { resolveInProject, displayPath } from '../config/paths.ts';
import type { Tool, ToolContext, ToolResult } from './types.ts';
import { ok, fail, str, num, bool } from './types.ts';

const DEFAULT_IGNORES = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.turbo',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  '.nave/sessions',
  '.nave/cache',
];

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.pdf', '.zip',
  '.gz', '.tar', '.7z', '.rar', '.exe', '.dll', '.so', '.dylib', '.class',
  '.jar', '.wasm', '.mp3', '.mp4', '.mov', '.avi', '.woff', '.woff2', '.ttf',
  '.otf', '.eot', '.sqlite', '.db', '.bin',
]);

const MAX_READ_LINES = 1500;
const MAX_LINE_CHARS = 2000;
const MAX_FILE_BYTES = 5_000_000;

/**
 * A read must fit the caller's slice of the context window. On a 10k window
 * that is roughly 2,200 tokens — about 200 lines of code, not 1,500.
 */
function readBudget(ctx: ToolContext): { lines: number; chars: number } {
  const chars = Math.max(1200, ctx.resultTokens * 3.2);
  return { lines: Math.max(40, Math.floor(chars / 42)), chars: Math.floor(chars) };
}

function guard(ctx: ToolContext, p: string): { path: string } | ToolResult {
  const { path, inside } = resolveInProject(ctx.cwd, p);
  if (!inside) {
    return fail(
      `${p} is outside the project directory (${ctx.cwd}). nave only touches files inside the project it was started in.`
    );
  }
  return { path };
}

export const readTool: Tool = {
  name: 'read',
  description:
    'Read a file from the project. Returns numbered lines so you can target edits precisely. ' +
    'Always read a file before writing or editing it.',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path to the file, relative to the project root.' },
      offset: { type: 'number', description: 'First line to read (1-based). Optional.' },
      limit: { type: 'number', description: 'How many lines to read. Optional.' },
    },
    required: ['file_path'],
  },
  async run(args, ctx) {
    const p = str(args, 'file_path');
    if (!p) return fail('file_path is required');
    const g = guard(ctx, p);
    if ('content' in g) return g;

    if (!existsSync(g.path)) return fail(`${p} does not exist`);
    const st = statSync(g.path);
    if (st.isDirectory()) return fail(`${p} is a directory — use the ls tool`);
    if (st.size > MAX_FILE_BYTES) {
      return fail(`${p} is ${Math.round(st.size / 1e6)} MB, too large to read in full. Use grep to find the part you need.`);
    }
    if (BINARY_EXT.has(extname(g.path).toLowerCase())) {
      return fail(`${p} looks like a binary file (${extname(g.path)}) and cannot be read as text`);
    }

    const raw = readFileSync(g.path, 'utf8');
    if (raw.includes('\u0000')) return fail(`${p} contains binary data`);

    const lines = raw.split(/\r?\n/);
    const budget = readBudget(ctx);
    const offset = Math.max(1, num(args, 'offset') ?? 1);
    const limit = Math.min(
      num(args, 'limit') ?? budget.lines,
      budget.lines,
      MAX_READ_LINES
    );
    const slice = lines.slice(offset - 1, offset - 1 + limit);

    ctx.readFiles.add(g.path);

    if (!slice.length) {
      return ok(
        `${p} has ${lines.length} lines; nothing at offset ${offset}.`,
        `read ${p} (empty range)`
      );
    }

    const numbered = slice
      .map((l, i) => {
        const n = String(offset + i).padStart(5, ' ');
        const text = l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)}… [truncated]` : l;
        return `${n}\t${text}`;
      })
      .join('\n');

    const shown = offset - 1 + slice.length;
    const more = shown < lines.length ? `\n\n[${lines.length - shown} more lines; re-read with offset ${shown + 1}]` : '';
    return ok(numbered + more, `read ${p} (${slice.length} lines)`);
  },
};

export const writeTool: Tool = {
  name: 'write',
  description:
    'Write a file, creating it or replacing its whole contents. ' +
    'For an existing file, read it first. Prefer the edit tool for partial changes.',
  readOnly: false,
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path to write, relative to the project root.' },
      content: { type: 'string', description: 'The complete new file contents.' },
    },
    required: ['file_path', 'content'],
  },
  async run(args, ctx) {
    const p = str(args, 'file_path');
    const content = str(args, 'content');
    if (!p) return fail('file_path is required');
    if (content === undefined) return fail('content is required');
    const g = guard(ctx, p);
    if ('content' in g) return g;

    const exists = existsSync(g.path);
    if (exists && !ctx.readFiles.has(g.path)) {
      return fail(
        `${p} already exists and has not been read in this session. Read it first so you do not discard work.`
      );
    }

    const perm = await ctx.permissions.check({
      tool: 'write',
      target: displayPath(ctx.cwd, g.path),
      description: exists ? `Overwrite ${p}` : `Create ${p}`,
    });
    if (!perm.allowed) return fail(`write to ${p} was not permitted — ${perm.reason}`);

    mkdirSync(dirname(g.path), { recursive: true });
    const before = exists ? readFileSync(g.path, 'utf8') : '';
    writeFileSync(g.path, content, 'utf8');
    ctx.readFiles.add(g.path);

    const delta = content.split('\n').length - (exists ? before.split('\n').length : 0);
    const verb = exists ? 'Updated' : 'Created';
    return ok(
      `${verb} ${p} (${content.split('\n').length} lines).`,
      `${verb.toLowerCase()} ${p} (${delta >= 0 ? '+' : ''}${delta} lines)`
    );
  },
};

export const editTool: Tool = {
  name: 'edit',
  description:
    'Replace an exact string in a file. old_string must appear exactly once unless replace_all is true. ' +
    'Read the file first. Include enough surrounding context to make the match unique.',
  readOnly: false,
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'File to edit.' },
      old_string: { type: 'string', description: 'Exact text to replace, including indentation.' },
      new_string: { type: 'string', description: 'Replacement text.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring uniqueness.' },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
  async run(args, ctx) {
    const p = str(args, 'file_path');
    const oldStr = str(args, 'old_string');
    const newStr = str(args, 'new_string');
    if (!p) return fail('file_path is required');
    if (oldStr === undefined) return fail('old_string is required');
    if (newStr === undefined) return fail('new_string is required');
    if (oldStr === newStr) return fail('old_string and new_string are identical');

    const g = guard(ctx, p);
    if ('content' in g) return g;
    if (!existsSync(g.path)) return fail(`${p} does not exist`);
    if (!ctx.readFiles.has(g.path)) {
      return fail(`${p} has not been read in this session. Read it first.`);
    }

    const before = readFileSync(g.path, 'utf8');
    const replaceAll = bool(args, 'replace_all') ?? false;
    const count = countOccurrences(before, oldStr);

    if (count === 0) {
      // A weak model can burn several steps guessing at whitespace. Show it
      // the closest region of the real file so the next attempt is informed.
      const near = nearestRegion(before, oldStr);
      return fail(
        `old_string was not found in ${p}.` +
          (near
            ? `\n\nThe closest matching part of the file is line ${near.line}:\n\n${near.text}\n\n` +
              'Copy from this exactly, including indentation and line endings.'
            : ' Re-read the file and copy the target text exactly, including indentation.')
      );
    }
    if (count > 1 && !replaceAll) {
      return fail(
        `old_string appears ${count} times in ${p}. Add surrounding context to make it unique, or pass replace_all: true.`
      );
    }

    const perm = await ctx.permissions.check({
      tool: 'edit',
      target: displayPath(ctx.cwd, g.path),
      description: `Edit ${p} (${count} replacement${count === 1 ? '' : 's'})`,
    });
    if (!perm.allowed) return fail(`edit to ${p} was not permitted — ${perm.reason}`);

    const after = replaceAll
      ? before.split(oldStr).join(newStr)
      : before.replace(oldStr, newStr);
    writeFileSync(g.path, after, 'utf8');

    const line = before.slice(0, before.indexOf(oldStr)).split('\n').length;
    return ok(
      `Edited ${p}: ${count} replacement${count === 1 ? '' : 's'} near line ${line}.`,
      `edited ${p}:${line}`
    );
  },
};

export const lsTool: Tool = {
  name: 'ls',
  description: 'List the files and directories at a path in the project.',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory to list. Defaults to the project root.' },
      all: { type: 'boolean', description: 'Include dotfiles and ignored directories.' },
    },
  },
  async run(args, ctx) {
    const p = str(args, 'path') ?? '.';
    const g = guard(ctx, p);
    if ('content' in g) return g;
    if (!existsSync(g.path)) return fail(`${p} does not exist`);
    const st = statSync(g.path);
    if (!st.isDirectory()) return fail(`${p} is a file — use the read tool`);

    const all = bool(args, 'all') ?? false;
    const entries = readdirSync(g.path, { withFileTypes: true })
      .filter((e) => all || (!e.name.startsWith('.') && !DEFAULT_IGNORES.includes(e.name)))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    if (!entries.length) return ok(`${p} is empty.`, `ls ${p} (empty)`);

    const lines = entries.map((e) => {
      if (e.isDirectory()) return `${e.name}/`;
      try {
        const size = statSync(join(g.path, e.name)).size;
        return `${e.name}  (${formatSize(size)})`;
      } catch {
        return e.name;
      }
    });
    return ok(`${p}:\n${lines.join('\n')}`, `ls ${p} (${entries.length} entries)`);
  },
};

export const globTool: Tool = {
  name: 'glob',
  description:
    'Find files by name pattern, e.g. "src/**/*.ts" or "**/*.test.js". Returns paths sorted by most recently modified.',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern, relative to the search path.' },
      path: { type: 'string', description: 'Directory to search in. Defaults to the project root.' },
      limit: { type: 'number', description: 'Maximum results (default 200).' },
    },
    required: ['pattern'],
  },
  async run(args, ctx) {
    const pattern = str(args, 'pattern');
    if (!pattern) return fail('pattern is required');
    const base = str(args, 'path') ?? '.';
    const g = guard(ctx, base);
    if ('content' in g) return g;
    if (!existsSync(g.path)) return fail(`${base} does not exist`);

    const limit = num(args, 'limit') ?? 200;
    const rx = globToRegex(pattern);
    const found: Array<{ rel: string; mtime: number }> = [];

    for (const file of walk(g.path, ctx.signal)) {
      const rel = relative(g.path, file).split(sep).join('/');
      if (!rx.test(rel)) continue;
      try {
        found.push({ rel, mtime: statSync(file).mtimeMs });
      } catch {
        found.push({ rel, mtime: 0 });
      }
      if (found.length >= limit * 4) break;
    }

    if (!found.length) return ok(`No files match ${pattern}.`, `glob ${pattern} (0)`);
    found.sort((a, b) => b.mtime - a.mtime);
    const shown = found.slice(0, limit);
    const more = found.length > limit ? `\n[${found.length - limit} more not shown]` : '';
    return ok(shown.map((f) => f.rel).join('\n') + more, `glob ${pattern} (${found.length})`);
  },
};

export const grepTool: Tool = {
  name: 'grep',
  description:
    'Search file contents with a regular expression. Use output_mode "files" to just locate files, ' +
    '"content" to see matching lines, or "count" for per-file totals.',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for.' },
      path: { type: 'string', description: 'File or directory to search. Defaults to the project root.' },
      glob: { type: 'string', description: 'Only search files matching this glob, e.g. "**/*.ts".' },
      output_mode: {
        type: 'string',
        enum: ['files', 'content', 'count'],
        description: 'What to return. Defaults to "files".',
      },
      case_insensitive: { type: 'boolean', description: 'Ignore case.' },
      context: { type: 'number', description: 'Lines of context around each match (content mode).' },
      limit: { type: 'number', description: 'Maximum matches or files to return (default 100).' },
    },
    required: ['pattern'],
  },
  async run(args, ctx) {
    const pattern = str(args, 'pattern');
    if (!pattern) return fail('pattern is required');
    const base = str(args, 'path') ?? '.';
    const g = guard(ctx, base);
    if ('content' in g) return g;
    if (!existsSync(g.path)) return fail(`${base} does not exist`);

    let rx: RegExp;
    try {
      rx = new RegExp(pattern, bool(args, 'case_insensitive') ? 'i' : '');
    } catch (err) {
      return fail(`invalid regular expression: ${(err as Error).message}`);
    }

    const mode = (str(args, 'output_mode') ?? 'files') as 'files' | 'content' | 'count';
    // Match the caller's context slice: ~55 chars per reported line.
    const roomLines = Math.max(20, Math.floor((ctx.resultTokens * 3.2) / 55));
    const limit = Math.min(num(args, 'limit') ?? 100, roomLines);
    const ctxLines = num(args, 'context') ?? 0;
    const globRx = str(args, 'glob') ? globToRegex(str(args, 'glob')!) : null;

    const targets = statSync(g.path).isFile()
      ? [g.path]
      : [...walk(g.path, ctx.signal)];

    const fileHits: Array<{ rel: string; count: number; lines: string[] }> = [];
    let total = 0;

    for (const file of targets) {
      if (ctx.signal.aborted) break;
      const rel = relative(ctx.cwd, file).split(sep).join('/');
      if (globRx && !globRx.test(relative(g.path, file).split(sep).join('/'))) continue;
      if (BINARY_EXT.has(extname(file).toLowerCase())) continue;

      let text: string;
      try {
        if (statSync(file).size > MAX_FILE_BYTES) continue;
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      if (text.includes('\u0000')) continue;

      const lines = text.split(/\r?\n/);
      const hits: string[] = [];
      let count = 0;
      for (let i = 0; i < lines.length; i++) {
        if (!rx.test(lines[i])) continue;
        count++;
        total++;
        if (mode === 'content' && hits.length < limit) {
          const from = Math.max(0, i - ctxLines);
          const to = Math.min(lines.length - 1, i + ctxLines);
          for (let j = from; j <= to; j++) {
            const marker = j === i ? ':' : '-';
            hits.push(`${rel}${marker}${j + 1}${marker}${clip(lines[j])}`);
          }
        }
      }
      if (count) fileHits.push({ rel, count, lines: hits });
      if (mode !== 'content' && fileHits.length >= limit) break;
    }

    if (!fileHits.length) return ok(`No matches for /${pattern}/.`, `grep ${pattern} (0)`);

    if (mode === 'files') {
      const list = fileHits.slice(0, limit).map((f) => f.rel).join('\n');
      const more = fileHits.length > limit ? `\n[${fileHits.length - limit} more files]` : '';
      return ok(
        `${fileHits.length} file(s) match:\n${list}${more}`,
        `grep ${pattern} (${fileHits.length} files)`
      );
    }
    if (mode === 'count') {
      const list = fileHits
        .sort((a, b) => b.count - a.count)
        .slice(0, limit)
        .map((f) => `${f.count.toString().padStart(6)}  ${f.rel}`)
        .join('\n');
      return ok(`${total} match(es):\n${list}`, `grep ${pattern} (${total} matches)`);
    }

    const out = fileHits.flatMap((f) => f.lines).slice(0, limit * 3);
    const more = total > limit ? `\n[${total - limit} more matches; narrow the pattern]` : '';
    return ok(out.join('\n') + more, `grep ${pattern} (${total} matches)`);
  },
};

function* walk(dir: string, signal: AbortSignal, depth = 0): Generator<string> {
  if (depth > 20 || signal.aborted) return;
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (signal.aborted) return;
    if (DEFAULT_IGNORES.includes(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      yield* walk(full, signal, depth + 1);
    } else if (e.isFile()) {
      yield full;
    }
  }
}

export function globToRegex(pattern: string): RegExp {
  let p = pattern.replace(/\\/g, '/');
  if (!p.includes('/') && !p.startsWith('**')) p = `**/${p}`;

  let rx = '';
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === '*') {
      if (p[i + 1] === '*') {
        // "**/" may match zero directories.
        if (p[i + 2] === '/') {
          rx += '(?:.*/)?';
          i += 2;
        } else {
          rx += '.*';
          i += 1;
        }
      } else {
        rx += '[^/]*';
      }
    } else if (ch === '?') {
      rx += '[^/]';
    } else if (ch === '{') {
      const close = p.indexOf('}', i);
      if (close > i) {
        const opts = p.slice(i + 1, close).split(',');
        rx += `(?:${opts.map(escapeRx).join('|')})`;
        i = close;
      } else {
        rx += '\\{';
      }
    } else {
      rx += escapeRx(ch);
    }
  }
  return new RegExp(`^${rx}$`, process.platform === 'win32' ? 'i' : '');
}

function escapeRx(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/**
 * Best guess at where the model meant to edit: the window of file lines whose
 * squashed text overlaps most with the squashed old_string.
 */
function nearestRegion(
  file: string,
  target: string
): { line: number; text: string } | null {
  const fileLines = file.split('\n');
  const targetLines = target.split('\n').filter((l) => l.trim());
  if (!targetLines.length || !fileLines.length) return null;

  const squash = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const needle = squash(targetLines[0]);
  if (needle.length < 3) return null;

  let bestLine = -1;
  let bestScore = 0;
  for (let i = 0; i < fileLines.length; i++) {
    const score = similarity(needle, squash(fileLines[i]));
    if (score > bestScore) {
      bestScore = score;
      bestLine = i;
    }
  }
  if (bestLine < 0 || bestScore < 0.4) return null;

  const from = Math.max(0, bestLine - 1);
  const to = Math.min(fileLines.length - 1, bestLine + targetLines.length);
  const text = fileLines
    .slice(from, to + 1)
    .map((l, i) => `${String(from + i + 1).padStart(5)}\t${l}`)
    .join('\n');
  return { line: bestLine + 1, text };
}

/** Cheap token-overlap ratio; good enough to point at the right place. */
function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const at = new Set(a.split(' '));
  const bt = new Set(b.split(' '));
  let shared = 0;
  for (const t of at) if (bt.has(t)) shared++;
  return shared / Math.max(at.size, bt.size);
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

function clip(s: string): string {
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
