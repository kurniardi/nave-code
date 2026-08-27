---
name: recover-text-tool-calls
title: Local models print tool calls as text — recover them
description: Even tool-capable models sometimes emit a JSON call in the reply body and then claim it ran; Agent.run parses those back out.
type: gotcha
created: 2026-08-27
updated: 2026-08-27
---
qwen2.5 with native tool support was observed emitting a fenced ```json block containing `{"name":"memory","arguments":{...}}` instead of a real tool call — and then telling the user the memory had been recorded. Nothing ran. Silent, confident failure.

**How to apply:** in `Agent.run`, when a turn comes back with no `tool_calls`, the reply is run through `parseProtocol` and any parsed call whose name matches a tool *this agent actually has* is executed. Matching against the real tool set is what keeps ordinary JSON in an answer from being mistaken for a call — do not loosen it.

The system prompt also tells the model that writing a call as text does not run it. Both defences matter; neither is sufficient alone.
