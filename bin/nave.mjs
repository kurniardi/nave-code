#!/usr/bin/env node
// nave-code launcher.
// Prefers the compiled build; falls back to running TypeScript directly
// (Node >= 22.18 strips types natively, so `npm run build` is optional).
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const compiled = join(here, '..', 'dist', 'index.js');
const source = join(here, '..', 'src', 'index.ts');
const entry = existsSync(compiled) ? compiled : source;

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
