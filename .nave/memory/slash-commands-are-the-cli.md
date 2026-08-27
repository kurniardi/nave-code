---
name: slash-commands-are-the-cli
title: Slash commands and CLI subcommands share one implementation
description: Commands live once in src/commands/slash.ts; cmdViaSlash exposes them to the shell.
type: architecture
created: 2026-08-27
updated: 2026-08-27
---
`/models`, `/gpu`, `/memory`, `/skills`, `/config`, `/pull` and friends are defined once in `src/commands/slash.ts`. `cmdViaSlash` in `src/index.ts` runs the same objects for the shell equivalents (`nave models`, `nave gpu`, …) with a throwaway session and a non-interactive `Permissions`.

**Why:** two implementations of the same command drift, and the drift is invisible until a user reports that the flag works in one place and not the other.

**How to apply:** add a command to the `COMMANDS` array and add its name to the `KNOWN` set in `parseArgs`. Do not write a bespoke `cmdX` unless it genuinely needs different behaviour — `init`, `doctor` and `gpu --apply` do, and they are the exceptions.
