---
name: paste-must-bypass-readline
title: Multi-line paste has to be intercepted before readline
description: readline treats every pasted newline as Enter; PasteFilter strips bracketed-paste markers and holds the text aside.
type: gotcha
created: 2026-08-27
updated: 2026-08-27
---
A terminal delivers a paste as ordinary keystrokes. readline sees each newline as Enter, so pasting twenty lines submitted twenty separate prompts.

**How to apply:** `src/ui/paste.ts` sits between stdin and readline as a Transform. It enables bracketed paste mode (`ESC[?2004h`), strips the `ESC[200~ … ESC[201~` wrapper, and hands the text to a callback instead of passing it through. A single-line paste is written into the line as normal; a multi-line one is held aside and a `[paste #N: X lines]` placeholder goes in, expanded on submit by `expandPastes`.

Three details that are easy to get wrong and are covered by `scripts/test-paste.ts`:
- Markers split across reads. A large paste arrives in several chunks, sometimes mid-marker; the filter holds back any suffix that could begin a marker.
- Terminals without bracketed paste (older conhost). Fallback heuristic: a single read containing a newline that is not at the very end is a paste, because typing delivers one character per event. A bare Enter must stay a submit.
- The filter is readline’s `input`, so it must expose `isTTY` and forward `setRawMode` to the real stdin, or readline never leaves cooked mode.

Related: [[one-owner-of-stdin]].
