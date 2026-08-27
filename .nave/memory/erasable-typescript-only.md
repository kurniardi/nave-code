---
name: erasable-typescript-only
title: Erasable-syntax TypeScript only
description: No enums, namespaces or constructor parameter properties — Node strips types natively, so non-erasable syntax breaks the no-build dev path.
type: convention
created: 2026-08-27
updated: 2026-08-27
---
The source is TypeScript that Node runs directly (`node src/index.ts`), because Node 22.18+ strips types without a build step. That only works for *erasable* syntax. `tsconfig.json` sets `erasableSyntaxOnly: true` so `tsc` catches violations.

Banned: `enum`, `namespace`, and constructor parameter properties (`constructor(private x: T)`). Declare the field and assign it in the body instead.

Relative imports must end in `.ts`, not `.js`. `allowImportingTsExtensions` plus `rewriteRelativeImportExtensions` makes `tsc` rewrite them on build, and Node resolves them as written in dev.

**Why:** the zero-build dev loop is worth more than the syntax sugar, and a parameter property that typechecks but crashes at runtime is a trap nobody expects. Related: [[zero-runtime-dependencies]].
