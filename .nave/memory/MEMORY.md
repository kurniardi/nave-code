# Project memory

Durable notes nave keeps about this project. One file per fact.
Loaded at the start of every nave session — keep it short and true.

## Decision

- [Never add a hosted model provider](no-cloud-fallback.md) **[pinned]** — All inference goes to a local Ollama server; a cloud fallback would defeat the whole project.
- [Zero runtime dependencies](zero-runtime-dependencies.md) — Only typescript and @types/node, both dev-only — everything else is a Node built-in.

## Convention

- [Erasable-syntax TypeScript only](erasable-typescript-only.md) — No enums, namespaces or constructor parameter properties — Node strips types natively, so non-erasable syntax breaks the no-build dev path.

## Architecture

- [Slash commands and CLI subcommands share one implementation](slash-commands-are-the-cli.md) — Commands live once in src/commands/slash.ts; cmdViaSlash exposes them to the shell.

## Gotcha

- [Local models print tool calls as text — recover them](recover-text-tool-calls.md) — Even tool-capable models sometimes emit a JSON call in the reply body and then claim it ran; Agent.run parses those back out.
- [The VRAM budget must add back the resident model](vram-budget-counts-resident-model.md) — nvidia-smi reports an already-loaded model as used VRAM; without adding it back, every run after the first needlessly offloads layers to CPU.
