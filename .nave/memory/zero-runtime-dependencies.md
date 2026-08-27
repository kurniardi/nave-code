---
name: zero-runtime-dependencies
title: Zero runtime dependencies
description: Only typescript and @types/node, both dev-only — everything else is a Node built-in.
type: decision
created: 2026-08-27
updated: 2026-08-27
---
package.json has no `dependencies`, only `devDependencies`. Node 22.18+ built-ins cover the whole surface: `fetch` for Ollama, `readline/promises` for the REPL, `node:fs`/`node:path` for files, `node:child_process` for the shell. YAML frontmatter, glob matching, ANSI styling and table layout are all hand-written in `src/util` and `src/ui`.

**Why:** an offline-first tool that needs a working npm registry to run is a contradiction. It also keeps install instant and the supply chain empty.

**How to apply:** before adding a package, check whether a built-in does it. If something genuinely needs a dependency, that is a conversation, not a commit. See [[erasable-typescript-only]] for the related build constraint.
