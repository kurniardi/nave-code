# Security Policy

nave-code runs a language model that can read your files, write to them, and
execute shell commands on your machine. That is what it is for. This document
describes where the boundaries are, what counts as a vulnerability, and how to
report one.

---

## Reporting a vulnerability

**Please do not open a public issue for a security vulnerability.**

Use GitHub's private vulnerability reporting, which keeps the report
confidential until a fix exists:

> **Security** tab → **Report a vulnerability**

Include, as far as you can:

- The version (`nave --version`) or commit you saw it on
- What an attacker could achieve, and what access they would need first
- The smallest reproduction you can manage
- The model and permission mode in use, since behaviour differs sharply
  between them

You will get an acknowledgement and a decision on scope. If the report is
accepted you will be kept informed, and credited in the release notes unless
you would rather not be.

---

## Supported versions

| Version | Supported |
|---|---|
| Latest release on npm | ✅ |
| `main` | ✅ |
| Earlier releases | ❌ — fixes ship in a new release rather than being backported |

`0.1.0` is deprecated and cannot start once installed. Upgrade rather than
report anything against it.

---

## The security model

nave is offline by design. Understanding these four boundaries tells you most
of what you need:

**Nothing leaves your machine.** Inference goes to an Ollama server you run.
There is no telemetry, no analytics, no cloud fallback, and no API key to
leak. The single exception is `nave pull`, which downloads a model from the
Ollama registry, and only when you ask for it.

**The `http` tool cannot reach the public internet.** It accepts localhost and
private-network addresses only — enough to check a dev server you just
started, and nothing else. Public hosts are refused
(`src/tools/http.ts`).

**File tools stay inside the project.** Every path is resolved against the
directory nave was started in, and anything that escapes it is rejected
(`resolveInProject`, `src/tools/fs.ts`). An existing file must be read before
it can be written or edited, so the model cannot overwrite something it has
never seen.

**Permission modes are the real control.** In the default `ask` mode every
write, edit and command is confirmed by you. `plan` is read-only. `full` and
`--yes` disable prompting entirely — that is their purpose, and running an
untrusted prompt in that mode is equivalent to running the command yourself.

---

## What is in scope

- A path that escapes the project directory despite `resolveInProject`
- The `http` tool reaching a public host
- A command executing, or a file being written, without the confirmation the
  active permission mode promises
- A permission rule (`bash(npm run *)`, `edit(src/**)`) matching more than it
  should, or a mode change failing to withdraw the tools it should withdraw
- Credentials or file contents being written to a transcript, log or memory
  file where the user would not expect them
- Anything in nave reaching the network beyond the Ollama host and `nave pull`
- Vulnerabilities in this repository's GitHub Actions workflows

## What is out of scope

- **A model doing what you asked.** nave executing a destructive command you
  approved is not a vulnerability. Neither is `--yes` skipping the prompt.
- **Vulnerabilities in Ollama or in a model.** Report those to
  [Ollama](https://github.com/ollama/ollama) or the model's publisher.
- **Weak local-model judgement.** Small models follow instructions poorly and
  sometimes propose bad commands. That is why `ask` is the default.
- **Skills, agents and memory you installed yourself.** See below.

---

## Untrusted input reaching the model

Three things are read from disk and folded into the model's context. Each is a
prompt-injection surface, and each is under your control rather than nave's:

- **Skills** (`~/.claude/skills`, `~/.nave/skills`, `.nave/skills`) — Markdown
  read in place, whatever it says.
- **Custom agents** (`.nave/agents/*.md`) — these set a system prompt and a
  tool list.
- **Project memory** (`.nave/memory/`) and **`NAVE.md`** — the memory index is
  injected into *every* system prompt.

That last one deserves attention if you commit memory to a shared repository,
which nave encourages. A pull request that adds a memory file is a pull request
that edits the instructions your agent receives on every future run. **Review
changes under `.nave/` with the same care as changes to code.**

Treat a skill from any source as code you are about to run, because
effectively it is.

---

## Before you trust a session

- Keep the default `ask` mode for unfamiliar work, and read the commands.
- Use `--plan` when you want investigation with no possibility of a change.
- Reserve `full` / `--yes` for prompts you wrote, in repositories you control.
- Remember that `bash` runs with your user's privileges. nave does not sandbox
  it, and does not claim to.
