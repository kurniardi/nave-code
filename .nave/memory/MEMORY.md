# Project memory

Durable notes nave keeps about this project. One file per fact.
Loaded at the start of every nave session — keep it short and true.

## Decision

- [Never add a hosted model provider](no-cloud-fallback.md) **[pinned]** — All inference goes to a local Ollama server; a cloud fallback would defeat the whole project.
- [Zero runtime dependencies](zero-runtime-dependencies.md) — Only typescript and @types/node, both dev-only — everything else is a Node built-in.

## Convention

- [Erasable-syntax TypeScript only](erasable-typescript-only.md) — No enums, namespaces or constructor parameter properties — Node strips types natively, so non-erasable syntax breaks the no-build dev path.

## Architecture

- [Only one thing may hold stdin at a time](one-owner-of-stdin.md) — Reusing the session readline for permission prompts deadlocks; InputController owns stdin and releases it between prompts.
- [Slash commands and CLI subcommands share one implementation](slash-commands-are-the-cli.md) — Commands live once in src/commands/slash.ts; cmdViaSlash exposes them to the shell.

## Gotcha

- [Every context limit scales with the window](budgets-scale-with-the-window.md) — Fixed token/char constants overflow a 10k window before the first message; src/core/budget.ts derives every limit from numCtx.
- [The launcher must not run a stale dist](launcher-prefers-fresh-source.md) — bin/nave.mjs compares dist mtime against the newest src/*.ts, or an old build silently shadows your edits.
- [Multi-line paste has to be intercepted before readline](paste-must-bypass-readline.md) — readline treats every pasted newline as Enter; PasteFilter strips bracketed-paste markers and holds the text aside.
- [Local models print tool calls as text — recover them](recover-text-tool-calls.md) — Even tool-capable models sometimes emit a JSON call in the reply body and then claim it ran; Agent.run parses those back out.
- [Send think:false explicitly to thinking models](thinking-must-be-explicit.md) — qwen3-class models reason by default; omitting the flag spends thousands of invisible tokens out of a small window.
- [The VRAM budget must add back the resident model](vram-budget-counts-resident-model.md) — nvidia-smi reports an already-loaded model as used VRAM; without adding it back, every run after the first needlessly offloads layers to CPU.
