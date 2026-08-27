---
name: budgets-scale-with-the-window
title: Every context limit scales with the window
description: Fixed token/char constants overflow a 10k window before the first message; src/core/budget.ts derives every limit from numCtx.
type: gotcha
created: 2026-08-27
updated: 2026-08-27
---
v0.1.0 used constants: a 24,000-character tool-result cap and a system prompt allowed 45% of the window. Measured on the 6 GB dev card, where a 7B model gets ~10k context, that meant:

- system prompt 3,567 tokens + tool schemas 2,740 = **6,307 of 10,240 before the user said anything**
- one file read could add 6,000 more, overflowing the window on the first tool call
- compaction fired every turn, so long tasks appeared to "stop easily"

After routing everything through `contextBudget()` the same setup costs 3,475 tokens of fixed overhead (34%) and leaves 6,765 for work.

**How to apply:** never hard-code a token or character limit. Derive it from `contextBudget(numCtx)` in `src/core/budget.ts` and thread it through — `ToolContext.resultTokens` carries it to the tools, and `read`/`grep` size their output from it. When `budget.tight` is set (window under 16k), `selectTools` shortens tool descriptions, the skill catalogue is dropped from the prompt in favour of the skill tool, and `bash_readonly`/`http` are omitted.

Diagnose with `/context`, which shows the split and, on a tight window, the three ways to get more room. `gpu.kvCacheType: q4_0` measured 10k to 19k on qwen2.5:7b.
