# Changelog

Notable changes to nave-code. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0 — 2026-08-29

First public release. A terminal coding agent whose every token is generated
locally through [Ollama](https://ollama.com) — no API key, no account, no bill.

### Added

- **Per-project memory.** Durable notes in `.nave/memory/`, one file per fact,
  with a generated index injected into every system prompt. `NAVE.md` holds the
  standing brief. Both are meant to be committed; transcripts are not.
- **GPU-aware model routing.** Scores installed models against nine roles
  (`orchestrator`, `code`, `plan`, `review`, `explore`, `summarize`, `fast`,
  `vision`, `embed`) using family knowledge, native tool-calling support, and
  whether the model actually fits in VRAM. A 14B that spills to CPU scores below
  a 7B that fits.
- **VRAM planning from real GGUF metadata.** KV-cache cost is computed per token
  from the model's layers, KV heads and head dimension rather than estimated,
  then the largest context that fits is chosen. `nave gpu` shows the breakdown;
  `nave gpu --apply` tunes the Ollama server settings that matter, one
  confirmation at a time.
- **Sub-agents.** `orchestrator`, `coder`, `explorer`, `planner`, `reviewer`,
  `tester` and `scribe`, each with its own context window and model. Custom
  agents as Markdown in `.nave/agents/`.
- **Skills read in place** from `~/.claude/skills`, `~/.nave/skills` and
  `.nave/skills` — never copied, and later sources shadow earlier ones by name.
- **Tools:** `read`, `write`, `edit`, `glob`, `grep`, `ls`, `bash`,
  `bash_readonly`, `todo`, `memory`, `skill`, `task`, `http`. A file must be read
  before it is written, paths cannot escape the project, and `http` refuses
  anything that is not localhost or a private address.
- **Permission modes** — `ask`, `acceptEdits`, `plan`, `full` — cycled mid-session
  with Shift+Tab, with glob rules (`bash(npm run *)`, `edit(src/**)`).
- **Plan mode as a workflow.** `present_plan` shows the plan and offers to switch
  modes, handing back the mutating tools in the same turn so work starts with the
  plan already in context.
- Slash commands and CLI subcommands sharing one implementation, custom commands
  from `.nave/commands/`, session resume, and layered config
  (`~/.nave/config.json`, `.nave/config.json`, environment).
- `nave doctor` — one command that checks Ollama, models, GPU, skills, memory
  and Node.
- The startup mark, sampled from `icons/nave.png` into terminal cells ahead of
  time. Nothing decodes an image at runtime and the published package ships none.

### Notes

- Requires Node 22.18 or newer. nave runs its TypeScript directly, so the
  published package contains source and no build output.
- Zero runtime dependencies.
- Known rough edge: in plan mode a 7B model often narrates the first step instead
  of taking it. nave nudges twice while todos remain open, then stops. Larger
  models handle it correctly.
