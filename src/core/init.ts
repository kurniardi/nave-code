import { writeFileSync, existsSync, readFileSync, appendFileSync } from 'node:fs';
import { basename, relative } from 'node:path';
import { ensureDir, projectPaths } from '../config/paths.ts';
import { MemoryStore } from '../memory/store.ts';

/**
 * Prepare a project for nave: the memory directory, a conventions file and a
 * gitignore rule for transcripts. Everything created here is meant to be
 * committed except the session logs.
 */
export function writeProjectScaffold(cwd: string): string[] {
  const p = projectPaths(cwd);
  const created: string[] = [];

  ensureDir(p.root);
  if (!existsSync(p.agents)) {
    ensureDir(p.agents);
    created.push(rel(cwd, p.agents));
  }

  const store = new MemoryStore(cwd);
  if (!existsSync(p.memoryIndex)) {
    store.init();
    created.push(rel(cwd, p.memoryIndex));
  }

  if (!existsSync(p.conventions)) {
    writeFileSync(p.conventions, conventionsTemplate(basename(cwd)), 'utf8');
    created.push(rel(cwd, p.conventions));
  }

  const gitignore = `${cwd}/.gitignore`;
  const rules = ['.nave/sessions/', '.nave/cache/'];
  if (existsSync(gitignore)) {
    const current = readFileSync(gitignore, 'utf8');
    const missing = rules.filter((r) => !current.includes(r));
    if (missing.length) {
      appendFileSync(
        gitignore,
        `${current.endsWith('\n') ? '' : '\n'}\n# nave-code transcripts (memory in .nave/memory is meant to be committed)\n${missing.join('\n')}\n`,
        'utf8'
      );
      created.push(`${rel(cwd, gitignore)} (updated)`);
    }
  } else {
    writeFileSync(
      gitignore,
      `# nave-code transcripts (memory in .nave/memory is meant to be committed)\n${rules.join('\n')}\n`,
      'utf8'
    );
    created.push(rel(cwd, gitignore));
  }

  return created;
}

function rel(cwd: string, p: string): string {
  return relative(cwd, p).split('\\').join('/');
}

function conventionsTemplate(name: string): string {
  return `# ${name}

<!--
NAVE.md is this project's standing brief. nave reads it at the start of every
session, before it touches anything. Keep it short and true — a stale line here
is worse than a missing one.

Durable facts that outgrow this file belong in .nave/memory/ instead; nave
writes those itself as it works.
-->

## What this is

_One or two sentences: what the project does and who it is for._

## Running it

\`\`\`bash
# install
# build
# test
# run
\`\`\`

## Conventions

_The rules the code actually follows — naming, error handling, where things
live, what not to touch. Only write down what a newcomer would get wrong._

## Constraints

_Anything true about this project that is not visible in the code: deadlines,
platform limits, an API's quirks, a decision that looks wrong but is not._
`;
}
