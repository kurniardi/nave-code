---
name: thinking-must-be-explicit
title: Ask thinking models to think, and never resend the thinking
description: think:false does not stop a qwen3-class model reasoning — it only moves the reasoning into content, where it pollutes the answer.
type: gotcha
created: 2026-08-27
updated: 2026-08-28
---
Ollama treats a missing `think` field as "use the model default", so it must always be sent explicitly. The original conclusion — send `think: false` to save the window — was measured against Ollama 0.33.1 and qwen3:4b and does not hold:

- `think: false` → the reasoning still happens, but it arrives in `message.content`, ending in a stray `</think>`. It lands in the user's answer and in the session history. Same token cost, worse output.
- `think: true` → the reasoning arrives in `message.thinking` and `content` holds only the answer.

So the window is not saved by refusing to think; it is saved by refusing to *resend* the thinking. Two places carry this:

- `Agent.run` sends `think: true` for any thinking-capable model. `ui.showThinking` decides only whether the user sees it.
- `serialiseMessage` in `OllamaClient` does not put `thinking` back on the wire. Qwen3 expects its own past reasoning stripped from history, and resending it spends the window on tokens the model has already used.

`OllamaClient.chat` must keep testing `req.think !== undefined` rather than `if (req.think)` — a truthiness check on a boolean that is meaningful when false is the original bug, and it still matters for models where thinking is switched off.

**How to apply:** never omit `think`. Never send past `thinking` back. Related: [[budgets-scale-with-the-window]].
