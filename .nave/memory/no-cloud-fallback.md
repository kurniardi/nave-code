---
name: no-cloud-fallback
title: Never add a hosted model provider
description: All inference goes to a local Ollama server; a cloud fallback would defeat the whole project.
type: decision
created: 2026-08-27
updated: 2026-08-27
pinned: true
---
nave talks to one backend: an Ollama server on the user's own machine. There is no Anthropic/OpenAI/any-cloud provider, no API-key prompt, and no "fall back to the cloud when the local model struggles" path.

**Why:** the project exists so a coding agent costs nothing per token and never ships source code off the machine. A fallback provider would quietly reintroduce both, and users would have no way to know which turn went where.

**How to apply:** the only outbound network call in the codebase is `nave pull`, and only when the user asks for it. The `http` tool refuses any host that is not localhost or a private address — keep that guard. If a local model genuinely cannot do a job, say so and suggest a better local model; do not route around it.
