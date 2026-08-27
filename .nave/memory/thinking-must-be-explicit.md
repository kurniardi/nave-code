---
name: thinking-must-be-explicit
title: Send think:false explicitly to thinking models
description: qwen3-class models reason by default; omitting the flag spends thousands of invisible tokens out of a small window.
type: gotcha
created: 2026-08-27
updated: 2026-08-27
---
Ollama treats a missing `think` field as "use the model default", and qwen3-class models default to reasoning. On the ~10k window a 6 GB card allows, that silently spends thousands of tokens the user never sees and slows every turn.

Two places had to change together, and the second is easy to miss:

- `Agent.run` sends `think: config.ui.showThinking` for any thinking-capable model, rather than `true`-or-omit.
- `OllamaClient.chat` had `if (req.think) body.think = true`, which drops `false` on the floor. It now tests `req.think !== undefined`. A truthiness check on a boolean flag that is meaningful when false is the bug.

**How to apply:** thinking is off unless the user asks for it (`--thinking`, or `ui.showThinking: true`). If thinking is ever enabled per role for quality on plan/review, keep it explicit — never fall back to the model default. Related: [[budgets-scale-with-the-window]].
