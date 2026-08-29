# nave-code

<!--
This is nave's standing brief for its own repository. It is read at the start of
every session, before anything is touched. Keep it short and true.
-->

## What this is

A terminal coding agent that runs entirely on local Ollama models. No API key,
no billing, no cloud. Per-project memory and GPU-aware model
routing are the two features it exists for; everything else supports them.

## Running it

```bash
npm install            # typescript + @types/node, dev only
npm run dev            # node src/index.ts  — runs TS directly, no build step
npm run typecheck      # tsc --noEmit, must stay clean
npm run build          # optional dist/ build for faster startup
node src/index.ts doctor
```

`npm test` covers the interactive input path against a simulated TTY. Beyond
that, verify changes by running `doctor`, `models`, `gpu`, and at least one real
turn: `node src/index.ts --cwd <scratch> --yes -p "..."`. For anything touching
prompts, also drive the REPL through a pipe — the piped and TTY input paths are
genuinely different code.

## Conventions

- **Zero runtime dependencies.** Only `typescript` and `@types/node`, both dev.
  An offline tool that needs npm at runtime is a contradiction. Node 22.18+
  built-ins cover everything: `fetch`, `readline/promises`, `node:fs`.
- **Erasable-syntax TypeScript only.** No enums, no namespaces, no constructor
  parameter properties. Node strips types natively, so anything non-erasable
  breaks `node src/index.ts` even though `tsc` accepts it.
- **Relative imports end in `.ts`.** `rewriteRelativeImportExtensions` converts
  them on build. Do not write `.js`.
- **No literal control bytes in source.** Write the escape sequences for NUL and
  ESC, never the raw characters — some editors and tools silently mangle them.
- Errors the user sees say what to do next, not just what went wrong. Every
  failure path in `OllamaClient` carries a `hint`.
- Terminal output is built from the helpers in `src/ui/render.ts` — `panel`,
  `block`, `check`/`warnLine`/`crossLine`, `table`, `wordmark`. Do not hand-roll
  ANSI or table padding.
- All interactive input goes through `InputController` in `src/ui/input.ts`.
  Never open a second `readline` on stdin; see the `one-owner-of-stdin` memory.
- Never hard-code a token or character limit. Derive it from
  `contextBudget()` in `src/core/budget.ts`; on a 6 GB card the window is
  ~10k and fixed constants overflow it before the first message.

## Architecture

```
src/
├── index.ts        CLI entry, arg parsing, subcommands
├── core/           services (boot), turn runner, project scaffolding
├── agents/         agent definitions, custom-agent loader, the tool loop
├── providers/      Ollama client, model catalogue knowledge, router
├── gpu/            device detection, VRAM planning
├── memory/         per-project memory store
├── skills/         reads skill directories in place
├── tools/          read/write/edit/glob/grep/ls/bash/todo/memory/skill/task/http
├── prompt/         system prompt assembly, prompted tool-call fallback
├── session/        transcript persistence, compaction, permissions
├── commands/       slash commands (shared with the CLI subcommands)
└── ui/             renderer and REPL
```

`Services` (`src/core/services.ts`) is built once at boot and threaded
everywhere. Tools never import the agent; the agent injects `spawnAgent` into
the tool context instead, which is what keeps `task` from creating a cycle.

## Constraints

- The development machine is an **RTX 3060 Laptop with 6 GB VRAM**. Defaults are
  chosen for that, not for a 24 GB desktop. Never assume a model fits.
- Local models are markedly weaker at instruction-following than frontier ones.
  Two defences are already in place and should not be removed: the tool-call
  recovery in `Agent.run` (models that print a call as text instead of emitting
  it), and the tool-set trimming in `selectTools` for models under 4B.
- Slash commands and their CLI equivalents share one implementation in
  `src/commands/slash.ts`. Add a command once; `cmdViaSlash` exposes it to both.
