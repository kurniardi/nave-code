---
name: one-owner-of-stdin
title: Only one thing may hold stdin at a time
description: Reusing the session readline for permission prompts deadlocks; InputController owns stdin and releases it between prompts.
type: architecture
created: 2026-08-27
updated: 2026-08-27
---
v0.1.0 shipped with one long-lived `readline` for the whole REPL, paused during a turn and reused for permission prompts. That deadlocks: a nested `question()` on the paused interface never receives the keystroke. The user pressed `y`, nothing happened, and the spinner kept turning over a prompt that was no longer listening — the write never ran.

A second defect compounded it: the spinner repainted ` ESC[2K` every 90ms over the same line the prompt was drawn on, so even a working prompt looked frozen.

**How to apply:** all interactive input goes through `InputController` (`src/ui/input.ts`). Rules that must hold:

- Nothing holds stdin between prompts. `release()` pauses it so nothing echoes while the model streams.
- Line prompts build a readline, take one line, and close it. History is carried across by hand.
- Choice prompts never touch readline — raw keypress only, so a single `y` decides.
- **Piped stdin is a separate path.** A pipe delivers everything at once; the first readline swallows the whole buffer and drops the remainder on close, so the next prompt sees EOF. `PipedLines` holds the stream once and hands out lines.
- Any prompt suspends the live spinner first via `suspendSpinner()`, and restores it after.

Ctrl+C during a turn arrives as a process `SIGINT`, not through readline, because stdin is unowned then. `scripts/test-input.ts` covers the keypress path against a simulated TTY — a pipe cannot reach it.
