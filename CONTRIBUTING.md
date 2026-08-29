# Contributing to nave-code

Bug reports and patches are welcome. This file covers the mechanics; the design
rules live in [`NAVE.md`](NAVE.md) and are worth reading first, because most
review comments end up pointing back at them.

## Setup

```bash
git clone https://github.com/kurniardi/nave-code.git
cd nave-code
npm install          # typescript + @types/node, dev only
npm link             # puts `nave` on your PATH from this checkout
```

In a checkout there is no build step day to day: `npm run dev` runs
`node src/index.ts` directly on Node 22.18+, which strips the types as it loads.
Packaging is different — `npm pack` and `npm publish` run the build through
`prepack`, because an installed copy under `node_modules` can only run `dist/`.

Full environment setup — Node, Ollama, models — is in
[`INSTALL.md`](INSTALL.md).

## Before you open a PR

```bash
npm run typecheck    # must be clean
npm test
```

CI runs both on Windows, macOS and Linux against Node 22.18 and 24, plus a check
that the packed tarball still starts. All of it must pass.

Tests alone are not enough for anything user-facing. Also run:

```bash
node src/index.ts doctor
node src/index.ts models
node src/index.ts gpu
node src/index.ts --cwd <scratch-dir> --yes -p "make a trivial edit"
```

If you touched prompts, input handling or the REPL, drive it through a pipe as
well as a terminal — the piped and TTY paths are genuinely different code.

## The rules that will get a PR sent back

These are not style preferences. Each one is load-bearing:

- **Zero runtime dependencies.** Only `typescript` and `@types/node`, both dev.
  An offline tool that needs npm at runtime is a contradiction.
- **Erasable-syntax TypeScript only.** No enums, no namespaces, no constructor
  parameter properties. `tsc` accepts them; Node's type stripping does not, so
  `node src/index.ts` breaks even though the typecheck passed.
- **Relative imports end in `.ts`**, never `.js`.
- **No literal control bytes in source.** Write the escape sequences for NUL and
  ESC.
- **No hard-coded token or character limits.** Derive them from
  `contextBudget()` in `src/core/budget.ts`. On a 6 GB card the window is around
  10k, and a fixed constant overflows it before the first message.
- **No cloud fallback.** nave does not call a paid API, ever, including when a
  local model is struggling.
- **Terminal output goes through `src/ui/render.ts`** — `panel`, `block`,
  `table`, `check`. Do not hand-roll ANSI or column padding.
- **One owner of stdin.** All interactive input goes through `InputController`
  in `src/ui/input.ts`. Never open a second `readline`.

## Hardware assumptions

nave is developed on a 6 GB laptop GPU, and the defaults are chosen for that
rather than for a 24 GB desktop. If a change assumes more VRAM, say so in the PR
and keep the small-card path working. Never assume a model fits.

Local models follow instructions markedly worse than frontier ones. Two defences
exist for that — the text tool-call recovery in `Agent.run`, and the tool-set
trimming in `selectTools` for models under 4B. Do not remove either.

## Commits

Write the subject as an imperative sentence describing the change, matching the
existing history:

```
Stop thinking leaking into answers on qwen3-class models
Scale context limits to the window, and fix multi-line paste
```

Explain *why* in the body when it is not obvious. If a change spans files that
depend on each other, commit them together — a commit that leaves `main` unable
to start is worse than a large one.

## Reporting bugs

Open an issue and include the full `nave doctor` output. Nearly every bug in
nave depends on your GPU, your model and your Node version, and `doctor` reports
all three at once.
