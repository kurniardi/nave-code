<!--
Thanks for contributing. CONTRIBUTING.md has the setup and the rules that are
load-bearing rather than stylistic — worth a read if this is your first PR.
-->

## What this changes

<!-- One or two sentences. If it fixes an issue, write "Fixes #123". -->

## Why

<!-- The problem, not the patch. What went wrong, or what was missing? -->

## How it was verified

<!--
CI runs typecheck and tests on Windows, macOS and Linux, and checks that the
packed tarball still installs and starts. Tests alone are not enough for
anything user-facing — say what you actually ran.
-->

- [ ] `npm run typecheck` is clean
- [ ] `npm test` passes
- [ ] Ran a real turn against a local model, if this touches prompts, tools or the REPL
- [ ] Drove the REPL through a pipe as well as a terminal, if this touches input handling

Model and GPU used, if relevant:

## Checks

- [ ] No new runtime dependency
- [ ] Erasable-syntax TypeScript only — no enums, namespaces or parameter properties
- [ ] Relative imports end in `.ts`
- [ ] No hard-coded token or character limits; anything new derives from `contextBudget()`
- [ ] Works on a small VRAM budget, or says explicitly in the PR that it does not
