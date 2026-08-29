# Installing nave-code

nave is a coding agent that runs entirely on your own machine. Nothing here
creates an account, asks for a card, or sends your code anywhere.

You install three things, in this order:

| | What | Why |
|---|---|---|
| 1 | **Node 22.18+** | the runtime nave needs; 22.18 is the oldest version it is tested on |
| 2 | **Ollama** | the local server that actually runs the models |
| 3 | **nave-code** | one `npm install -g`, zero runtime dependencies |

Then nave itself tells you which models to download for your GPU.

A discrete GPU makes nave fast, but it is not required — nave detects what you
have, including nothing, and sizes itself to fit.

---

## 1. Node

nave needs **Node 22.18 or newer** — the oldest version it is tested against on
Windows, macOS and Linux. Node 24 LTS is recommended.

### Windows — PowerShell

```powershell
winget install OpenJS.NodeJS.LTS
```

### Windows — Command Prompt (cmd)

```bat
winget install OpenJS.NodeJS.LTS
```

`winget` ships with Windows 10 (1809+) and Windows 11. If you would rather not
use it, download the LTS installer from [nodejs.org](https://nodejs.org), or use
Chocolatey: `choco install nodejs-lts`.

> Close and reopen your terminal after installing — the PATH change does not
> reach shells that were already open.

### macOS

```bash
brew install node
```

No Homebrew? Get the `.pkg` from [nodejs.org](https://nodejs.org).

### Linux

Most distro packages are too old. Use a version manager:

```bash
# nvm — see https://github.com/nvm-sh/nvm#installing-and-updating
nvm install 24
nvm use 24
```

Or NodeSource on Debian/Ubuntu:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
```

Fedora: `sudo dnf install nodejs22` · Arch: `sudo pacman -S nodejs npm`

### Check it

```bash
node --version
```

You need `v22.18.0` or higher. If you see `v20.x` or lower, nave will refuse to
start and tell you so.

---

## 2. Ollama

[Ollama](https://ollama.com) is the local model server. nave talks to it over
`http://127.0.0.1:11434` and nothing else.

### Windows — PowerShell

```powershell
winget install Ollama.Ollama
```

### Windows — Command Prompt (cmd)

```bat
winget install Ollama.Ollama
```

Or download the installer from
[ollama.com/download/windows](https://ollama.com/download/windows). On Windows,
Ollama installs as a background service and starts on login — you do not need to
run anything yourself.

### macOS

```bash
brew install --cask ollama
```

Or download from [ollama.com/download/mac](https://ollama.com/download/mac).
Launch Ollama once; it lives in the menu bar and starts with your Mac.

### Linux

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

This installs a systemd service and starts it. Confirm with:

```bash
systemctl status ollama
```

If your distro has no systemd, run the server yourself in its own terminal:

```bash
ollama serve
```

### Check it

```bash
ollama --version
```

And confirm the server is actually answering:

**PowerShell**

```powershell
Invoke-RestMethod http://127.0.0.1:11434
```

**cmd**

```bat
curl http://127.0.0.1:11434
```

**macOS / Linux**

```bash
curl http://127.0.0.1:11434
```

You want the reply `Ollama is running`.

> In Windows PowerShell, `curl` is an alias for `Invoke-WebRequest` and prints a
> response object rather than the text. Use `Invoke-RestMethod` as shown, or
> spell it `curl.exe`.

---

## 3. nave-code

Same command on every platform — PowerShell, cmd, macOS and Linux alike:

```bash
npm install -g nave-code
```

**Run it from anywhere. You do not need to create a folder first.** The `-g`
means global: npm installs nave into its own directory, not into whichever
folder your terminal happens to be in. Nothing is written next to your code, and
no `node_modules` appears where you ran it.

If you want to see where it went:

```bash
npm root -g
```

That is the whole install. nave has **zero runtime dependencies**: npm fetches
the package and nothing else.

### Check it

```bash
nave doctor
```

`doctor` is the one command worth remembering. It checks every moving part and
tells you what to fix:

```
  nave-code v0.1.3 ────────────────────────────────────────────────
  local-first coding agent, powered by your own GPU
  checking this machine

Ollama
──────────
  ✓ Ollama 0.33.1 at http://127.0.0.1:11434

Models
──────────
  ✓ 2 models installed 2 with native tool calling

GPU
───────
  ✓ NVIDIA GeForce RTX 3060 Laptop GPU 6.0 GB VRAM, 5.9 GB free

Skills & memory
───────────────────
  ✓ 64 skills from ~/.claude/skills
  ✓ 12 project memories
  ✓ NAVE.md present

Runtime
───────────
  ✓ Node 24.18.0
  ✓ git available

╭─ Ready ──────────────────────────────────────────────────────────╮
│ Everything checks out.                                           │
│                                                                  │
│ → run nave in a project to start                                 │
╰──────────────────────────────────────────────────────────────────╯
```

---

## 4. A model

Do not guess at this. Ask nave, which has already read your VRAM:

```bash
nave pull
```

With no argument it prints what actually fits your card:

```
Recommended for your hardware
─────────────────────────────────
qwen2.5-coder:7b-instruct-q4_K_M  code          4.6 GB  the largest coder that still leaves KV-cache room on 6 GB
qwen3:4b                          orchestrator  2.9 GB  tool calling that fits alongside a 16k context
qwen3:1.7b                        fast          1.4 GB  compaction pass that will not evict the coder
nomic-embed-text                  embed         400 MB  memory search embeddings
```

Then download them:

```bash
nave pull qwen3:4b
nave pull qwen2.5-coder:7b-instruct-q4_K_M
```

`nave pull` is the **only** command in nave that touches the network.

<details>
<summary>If you want the table up front — recommendations by VRAM</summary>

| Your VRAM | Coding | Orchestrator | Fast |
|---|---|---|---|
| 22 GB+ | `qwen3-coder:30b` | `qwen3:14b` | `qwen3:4b` |
| 14–22 GB | `qwen2.5-coder:14b` | `qwen3:8b` | `qwen3:4b` |
| 7–14 GB | `qwen2.5-coder:7b` | `qwen3:8b` | `qwen3:1.7b` |
| 5–7 GB | `qwen2.5-coder:7b-instruct-q4_K_M` | `qwen3:4b` | `qwen3:1.7b` |
| Under 5 GB, or no GPU | `qwen2.5-coder:3b` | `qwen3:4b` | `qwen3:1.7b` |

`nomic-embed-text` (400 MB) is worth adding at every tier for memory search.

Start with the orchestrator and the coder. Two models is enough to work.

</details>

Check how nave rates what you installed:

```bash
nave models
```

---

## 5. Your first session

**This is where a folder matters.** nave works on the directory you start it in
— it reads and edits the files there, and keeps that project's memory there.
So move into a project first.

Already have one:

```bash
cd path/to/your-project
```

Starting from scratch? Make one:

```bash
mkdir my-project
cd my-project
git init
```

`git init` is optional, but worth doing: nave adds a rule to `.gitignore` for
its transcripts, and a repository is what lets you see and undo what nave
changed.

Then, inside that folder:

```bash
nave init      # creates NAVE.md and .nave/memory
nave           # start
```

`nave init` writes two things worth committing: `NAVE.md`, the standing brief
nave reads at the start of every session, and `.nave/memory/`, where it keeps
what it learns. It also adds `.nave/sessions/` to your `.gitignore`, because
transcripts are noise.

Inside a session, `/help` lists everything. **Shift+Tab** cycles permission
modes — `ask` prompts before every change, `plan` is read-only, `auto` applies
edits without asking.

Want one answer without the REPL?

```bash
nave -p "what does the router do?"
```

---

## Troubleshooting

**`nave : File ... cannot be loaded because running scripts is disabled` (PowerShell)**

Windows blocks the npm shim by default. Allow local scripts for your own user:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

Then reopen PowerShell. cmd is unaffected by this.

**`nave: this Node build cannot run TypeScript directly`**

Your Node is older than 22.18. Check with `node --version` and upgrade. If you
manage several versions, make sure the *global* one is the new one —
`npm root -g` shows which install npm is actually using.

**`nave` is not recognised / command not found**

The npm global bin directory is not on your PATH. Find it with `npm prefix -g`
and add its `bin` to PATH. On Windows the usual fix is simply to close and
reopen the terminal after installing Node.

**`EACCES: permission denied` on `npm install -g` (macOS / Linux)**

Do not reach for `sudo`. Install Node through `nvm` or `fnm` instead, which puts
the global directory inside your home folder and removes the problem.

**Ollama is not reachable**

`nave doctor` says so explicitly. Start it:

- **Windows** — check the Ollama icon in the system tray, or run `ollama serve`
- **macOS** — launch Ollama from Applications
- **Linux** — `sudo systemctl start ollama`, or `ollama serve` in its own terminal

If Ollama runs somewhere else, point nave at it:

```bash
nave config set ollama.host http://127.0.0.1:11434
```

**The model is slow, or my GPU is not being used**

```bash
nave gpu
```

That prints exactly where your VRAM goes — weights, KV cache, compute buffers —
and what nave did about it. If a model does not fit, nave trims the context or
offloads layers and says so. `nave gpu --apply` will tune the Ollama server
settings that matter, showing you each one before it changes anything.

The usual cause is simply too large a model. Drop a tier in the table above.

---

## Uninstalling

```bash
npm uninstall -g nave-code
```

Models stay in Ollama; remove them with `ollama rm <model>`. Per-project files
live in `NAVE.md` and `.nave/` — delete those folders if you want them gone.

---

## Building from source

Use this instead of `npm install -g` when you want to **change nave itself**.
For simply using it, the global install above is the easier path.

You need [git](https://git-scm.com) as well as Node.

```bash
git clone https://github.com/kurniardi/nave-code.git
cd nave-code
npm install          # typescript + @types/node, dev only
npm run typecheck
npm test
npm link
```

Run these one at a time, in order. `cd` and `npm install` are not optional:
`git clone` only downloads the code, and `npm link` fails without the
dev dependencies.

### What `npm link` does

It points the `nave` command on your PATH at this folder, rather than at a copy
downloaded from npm. Two consequences:

- **Your edits are live.** Change a file in `src/`, run `nave` again, and the
  change is already there. No reinstall, no build step.
- **It replaces the global install.** If you ran `npm install -g nave-code`
  earlier, `nave` now runs your clone instead. That is the point, but it is
  worth knowing which one you are running.

Check which one is active at any time:

```bash
npm ls -g --depth=0
```

A linked package shows as a path to your clone. An ordinary install shows a
version number.

### Going back to the published version

```bash
npm uninstall -g nave-code
npm install -g nave-code
```

The first line removes the link — it does not touch your clone, which stays
where it is.

`npm run dev` runs `node src/index.ts` directly, so day to day there is no build
step in a checkout. `npm run build` produces `dist/`, and the launcher prefers it
only while it is newer than `src/`. Packing runs the build for you: the published
package has to carry `dist/`, because Node refuses to strip types under
`node_modules`.

Read [`NAVE.md`](NAVE.md) before changing anything; it is the brief nave itself
follows in this repo.
