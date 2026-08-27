---
name: mode-changes-must-refresh-tools
title: A permission-mode change must rebuild the tool set, not just the prompt
description: Plan mode withholds mutating tools; approving a plan has to hand them back mid-turn or the model narrates work it cannot do.
type: gotcha
created: 2026-08-27
updated: 2026-08-27
---
The tool selection used to be computed once at the top of `Agent.run`. In plan mode `selectTools` filters to read-only plus `present_plan`, so after the user approved a plan the model was told "go build it" while `edit` and `write` were still absent from its tool list. It responded by claiming it had made the change. Refreshing only the system prompt was not enough — the tools are the part that matters.

**How to apply:** `pickTools()` is a closure re-invoked whenever `permissions.currentMode` changes during the loop, and `selection` is reassigned before `refreshSystem()` runs so the rebuilt prompt describes the new set. If another mid-turn mode change is ever added, it must go through the same path.

**Known limit, measured:** with qwen2.5:7b the plan flow itself works — mode switches, tools return, the nudge fires — but the model still narrates instead of calling `edit` after approval. The same model completes the same task reliably in ordinary auto mode. Plan mode asks for a longer conversation than a 7B holds together; try a stronger model before assuming a regression.

Related: [[budgets-scale-with-the-window]].
