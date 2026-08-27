#!/usr/bin/env node
// nave-code launcher.
//
// Prefers the compiled build, but only while it is actually current: Node >=
// 22.18 runs the TypeScript directly, so a stale dist/ would otherwise make
// `nave` silently run yesterday's code after you edit src/.
import { existsSync, statSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const compiled = join(root, 'dist', 'index.js');
const source = join(root, 'src', 'index.ts');

function newestMtime(dir) {
  let newest = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return newest;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(full));
    } else if (entry.name.endsWith('.ts')) {
      try {
        newest = Math.max(newest, statSync(full).mtimeMs);
      } catch {
        /* ignore */
      }
    }
  }
  return newest;
}

let entry = source;
if (existsSync(compiled)) {
  try {
    entry = statSync(compiled).mtimeMs >= newestMtime(join(root, 'src')) ? compiled : source;
  } catch {
    entry = compiled;
  }
}

try {
  await import(pathToFileURL(entry).href);
} catch (err) {
  if (entry === source && String(err?.message ?? '').includes('Unknown file extension')) {
    console.error(
      'nave: this Node build cannot run TypeScript directly.\n' +
        `Node ${process.version} detected; nave needs >= 22.18, or run "npm run build" once.`
    );
    process.exit(1);
  }
  throw err;
}
