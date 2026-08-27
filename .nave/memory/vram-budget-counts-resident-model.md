---
name: vram-budget-counts-resident-model
title: The VRAM budget must add back the resident model
description: nvidia-smi reports an already-loaded model as used VRAM; without adding it back, every run after the first needlessly offloads layers to CPU.
type: gotcha
created: 2026-08-27
updated: 2026-08-27
---
`planRuntime` sizes the context from *free* VRAM rather than total, because the desktop compositor and other apps are real competitors. But the model nave is about to use is often already resident from the previous run (`keepAlive` defaults to 15m), and the driver counts that as used.

Observed on the 6 GB dev card: first run saw 5.9 GB free and kept all layers on GPU; the second run saw 2.5 GB free and offloaded 7 of 28 layers, for no reason at all.

**How to apply:** `ModelRouter.plan()` passes `residentMb` from `/api/ps`, and `planRuntime` adds it back (capped at physical VRAM). If you change the budget maths, keep that term. `ModelRouter.refreshResident()` is the only place `/api/ps` is read for this purpose.
