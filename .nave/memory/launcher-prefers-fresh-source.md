---
name: launcher-prefers-fresh-source
title: The launcher must not run a stale dist
description: bin/nave.mjs compares dist mtime against the newest src/*.ts, or an old build silently shadows your edits.
type: gotcha
created: 2026-08-27
updated: 2026-08-27
---
`bin/nave.mjs` preferred `dist/index.js` whenever it existed. Run `npm run build` once, then edit `src/`, and the globally linked `nave` keeps running the old compiled code — with no warning. It cost real debugging time: a fixed command kept showing its old output.

**How to apply:** the launcher now walks `src/` for the newest `.ts` mtime and only uses `dist/` when the build is at least as new. If you add a source directory outside `src/`, include it in that scan.
