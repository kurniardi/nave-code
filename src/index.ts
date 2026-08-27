import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { PRODUCT, VERSION } from './version.ts';
import { c, accent, muted, setColor } from './util/colors.ts';
import { banner, heading, table, errorBox } from './ui/render.ts';
import { boot } from './core/services.ts';
import type { Services } from './core/services.ts';
import { runRepl } from './ui/repl.ts';
import { Session } from './session/session.ts';
import { Permissions } from './session/permissions.ts';
import { TodoList } from './tools/todo.ts';
import { executeTurn } from './core/run.ts';
import { writeProjectScaffold } from './core/init.ts';
import { findCommand } from './commands/slash.ts';
import type { SlashContext } from './commands/slash.ts';
import { formatMb } from './gpu/detect.ts';
import { serverEnvRecommendations } from './gpu/tuning.ts';
import { recommendedPulls } from './providers/catalog.ts';
import { allAgents, agentTemplate } from './agents/loader.ts';
import { userPaths, projectPaths, ensureDir } from './config/paths.ts';
import { run as execute, which } from './util/exec.ts';

interface Cli {
  command: string | null;
  rest: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Cli {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  const takesValue = new Set([
    'cwd', 'model', 'm', 'agent', 'resume', 'allow', 'p', 'print',
  ]);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const [name, inline] = splitOnce(arg.slice(2), '=');
      if (inline !== null) flags[name] = inline;
      else if (takesValue.has(name) && argv[i + 1] && !argv[i + 1].startsWith('-')) flags[name] = argv[++i];
      else flags[name] = true;
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      const name = arg.slice(1);
      if (takesValue.has(name) && argv[i + 1] && !argv[i + 1].startsWith('-')) flags[name] = argv[++i];
      else flags[name] = true;
      continue;
    }
    positional.push(arg);
  }

  const KNOWN = new Set([
    'init', 'doctor', 'models', 'model', 'gpu', 'memory', 'skills',
    'agents', 'pull', 'config', 'sessions', 'help', 'version', 'tools',
  ]);
  const first = positional[0];
  if (first && KNOWN.has(first)) {
    return { command: first, rest: positional.slice(1), flags };
  }
  return { command: null, rest: positional, flags };
}

function splitOnce(s: string, sep: string): [string, string | null] {
  const i = s.indexOf(sep);
  return i < 0 ? [s, null] : [s.slice(0, i), s.slice(i + 1)];
}

async function main(): Promise<number> {
  const cli = parseArgs(process.argv.slice(2));

  if (cli.flags['no-color']) setColor(false);
  if (cli.flags.version || cli.flags.v || cli.command === 'version') {
    process.stdout.write(`${PRODUCT} ${VERSION}\n`);
    return 0;
  }
  if (cli.flags.help || cli.flags.h || cli.command === 'help') {
    process.stdout.write(usage());
    return 0;
  }

  const cwd = resolve(String(cli.flags.cwd ?? process.cwd()));
  if (!existsSync(cwd)) {
    process.stderr.write(errorBox('No such directory', cwd) + '\n');
    return 1;
  }

  // Commands that must work with the Ollama server down.
  const offline = cli.command === 'init' || cli.command === 'config' || cli.command === 'sessions';

  let services: Services;
  try {
    services = await boot({ cwd, offline });
  } catch (err) {
    const e = err as Error & { hint?: string | null };
    process.stderr.write(
      errorBox('Cannot start', e.message, e.hint ?? 'Is the Ollama server running? Try: ollama serve') + '\n'
    );
    return 1;
  }

  applyCliOverrides(services, cli);

  switch (cli.command) {
    case 'init':
      return cmdInit(services);
    case 'doctor':
      return cmdDoctor(services);
    case 'gpu':
      return cmdGpu(services, cli);
    case 'agents':
      return cmdAgents(services, cli);
    case 'models':
    case 'model':
    case 'memory':
    case 'skills':
    case 'pull':
    case 'config':
    case 'sessions':
    case 'tools':
      return cmdViaSlash(services, cli);
    default:
      return cmdSession(services, cli);
  }
}

function applyCliOverrides(services: Services, cli: Cli): void {
  const model = cli.flags.model ?? cli.flags.m;
  if (typeof model === 'string') services.config.models.default = model;
  if (cli.flags.plan) services.config.permissions.mode = 'plan';
  if (cli.flags.yes || cli.flags.y) services.config.permissions.mode = 'full';
  if (cli.flags['accept-edits']) services.config.permissions.mode = 'acceptEdits';
  if (cli.flags.thinking) services.config.ui.showThinking = true;
  const allow = cli.flags.allow;
  if (typeof allow === 'string') {
    services.config.permissions.allow.push(...allow.split(',').map((s) => s.trim()));
  }
}

/** Reuse the slash-command implementations for their CLI equivalents. */
async function cmdViaSlash(services: Services, cli: Cli): Promise<number> {
  const name = cli.command === 'model' && cli.rest.length === 0 ? 'models' : cli.command!;
  const cmd = findCommand(name);
  if (!cmd) {
    process.stderr.write(`Unknown command: ${name}\n`);
    return 1;
  }
  const session = new Session(services.cwd);
  const ctx: SlashContext = {
    services,
    session,
    permissions: new Permissions(services.config, null),
    setSession: () => {},
    lastStats: null,
  };
  try {
    const res = await cmd.run(cli.rest.join(' '), ctx);
    if (res.output) process.stdout.write(`${res.output}\n`);
    return 0;
  } catch (err) {
    const e = err as Error & { hint?: string | null };
    process.stderr.write(errorBox(`${name} failed`, e.message, e.hint ?? undefined) + '\n');
    return 1;
  }
}

function cmdInit(services: Services): number {
  const created = writeProjectScaffold(services.cwd);
  process.stdout.write(banner(services.cwd));
  if (created.length) {
    process.stdout.write(`${accent('✓')} created:\n`);
    for (const f of created) process.stdout.write(muted(`    ${f}\n`));
  } else {
    process.stdout.write(muted('  already set up — nothing to create\n'));
  }
  process.stdout.write(
    [
      '',
      `  ${muted('Next:')} run ${c.bold('nave')} in this directory and say:`,
      `    ${accent('"study this project and fill in NAVE.md and your memory"')}`,
      '',
    ].join('\n')
  );
  return 0;
}

async function cmdDoctor(services: Services): Promise<number> {
  const out: string[] = [banner('environment check')];
  let problems = 0;

  // Ollama server.
  const health = await services.client.health();
  out.push(heading('Ollama'));
  if (health.ok) {
    out.push(`  ${c.green('✓')} server ${c.bold(health.version ?? '')} at ${services.client.host}`);
  } else {
    problems++;
    out.push(
      `  ${c.red('✗')} cannot reach ${services.client.host}`,
      muted(`    ${health.error ?? ''}`),
      `    ${accent('→')} start it with ${c.bold('ollama serve')}`
    );
    const bin = await which('ollama');
    if (!bin) out.push(`    ${accent('→')} ollama is not on PATH — install it from https://ollama.com`);
  }

  // Models.
  out.push(heading('Models'));
  if (!services.router.models.length) {
    problems++;
    out.push(`  ${c.yellow('!')} no models installed`);
    const recs = recommendedPulls(services.gpu.totalVramMb || 4000);
    out.push(muted('    sized for your hardware:'));
    for (const r of recs) {
      out.push(`      ${c.bold(`nave pull ${r.model}`)}  ${muted(`— ${r.why}`)}`);
    }
  } else {
    const withTools = services.router.models.filter((m) => m.supportsTools);
    out.push(`  ${c.green('✓')} ${services.router.models.length} installed, ${withTools.length} with native tool calling`);
    if (!withTools.length) {
      problems++;
      out.push(
        `  ${c.yellow('!')} none support tool calling — nave will fall back to a text protocol`,
        muted('    a tool-capable model (qwen3, qwen2.5-coder, llama3.1, mistral) is strongly recommended')
      );
    }
    const fits = services.router.models.filter((m) => services.router.plan(m).fitsFully);
    if (!fits.length) {
      problems++;
      out.push(`  ${c.yellow('!')} no installed model fits your VRAM — everything will partly run on CPU`);
    }
  }

  // GPU.
  out.push(heading('GPU'));
  if (services.gpu.gpus.length) {
    for (const g of services.gpu.gpus) {
      out.push(
        `  ${c.green('✓')} ${c.bold(g.name)} — ${formatMb(g.totalMb)}${g.unified ? ' unified' : ' VRAM'}` +
          (g.freeMb !== null ? muted(`, ${formatMb(g.freeMb)} free`) : '')
      );
    }
    if (services.gpu.totalVramMb > 0 && services.gpu.totalVramMb < 6000) {
      out.push(
        muted('    small VRAM: nave will trim context and prefer 4-bit quants. /gpu shows the plan.')
      );
    }
  } else {
    out.push(`  ${c.yellow('!')} no GPU detected (${services.gpu.detectedBy}) — generation will be slow on CPU`);
  }

  const envRecs = serverEnvRecommendations(services.config).filter(
    (r) => process.env[r.key] !== r.value
  );
  if (envRecs.length) {
    out.push(muted(`    ${envRecs.length} server setting(s) not tuned — run ${c.bold('nave gpu --apply')}`));
  }

  // Skills and memory.
  out.push(heading('Skills & memory'));
  out.push(
    services.skills.count
      ? `  ${c.green('✓')} ${services.skills.count} skills from ${services.skills.scanned.join(', ')}`
      : `  ${c.yellow('!')} no skills found in ${services.config.skills.sources.join(', ')}`
  );
  const memories = services.memory.list();
  const p = projectPaths(services.cwd);
  out.push(
    memories.length
      ? `  ${c.green('✓')} ${memories.length} project memories in ${p.memory}`
      : existsSync(p.memory)
        ? muted('  · memory initialised but empty — nave will fill it as it works')
        : `  ${c.yellow('!')} this project is not initialised — run ${c.bold('nave init')}`
  );
  out.push(
    existsSync(p.conventions)
      ? `  ${c.green('✓')} NAVE.md present`
      : muted('  · no NAVE.md — nave init creates one')
  );

  // Runtime.
  out.push(heading('Runtime'));
  const major = Number(process.versions.node.split('.')[0]);
  out.push(
    major >= 22
      ? `  ${c.green('✓')} Node ${process.versions.node}`
      : `  ${c.red('✗')} Node ${process.versions.node} — nave needs 22.18 or newer`
  );
  if (major < 22) problems++;

  const git = await which('git');
  out.push(git ? `  ${c.green('✓')} git available` : muted('  · git not found — version-control tools will not work'));

  out.push('');
  out.push(
    problems === 0
      ? `${c.green('Everything checks out.')} ${muted('Run "nave" in a project to start.')}`
      : `${c.yellow(`${problems} thing(s) to fix.`)} ${muted('Each one above has the command to fix it.')}`
  );
  out.push('');
  process.stdout.write(out.join('\n'));
  return problems === 0 ? 0 : 1;
}

async function cmdGpu(services: Services, cli: Cli): Promise<number> {
  if (!cli.flags.apply) return cmdViaSlash(services, { ...cli, command: 'gpu' });

  const recs = serverEnvRecommendations(services.config).filter(
    (r) => process.env[r.key] !== r.value
  );
  if (!recs.length) {
    process.stdout.write(`${c.green('✓')} Ollama server settings are already tuned.\n`);
    return 0;
  }

  process.stdout.write(heading('Apply Ollama server settings') + '\n');
  process.stdout.write(
    muted('  These are user-level environment variables. Ollama must be restarted to pick them up.\n\n')
  );
  for (const r of recs) {
    process.stdout.write(`  ${accent(r.key)}=${c.bold(r.value)}\n    ${muted(r.why)}\n`);
  }
  process.stdout.write('\n');

  if (!cli.flags.yes && !cli.flags.y) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(`  ${accent('?')} apply these? [y/N] `)).trim().toLowerCase();
    rl.close();
    if (answer !== 'y' && answer !== 'yes') {
      process.stdout.write(muted('  cancelled\n'));
      return 0;
    }
  }

  if (process.platform === 'win32') {
    for (const r of recs) {
      const res = await execute('setx', [r.key, r.value], { timeoutMs: 10_000 });
      process.stdout.write(
        res.code === 0
          ? `  ${c.green('✓')} ${r.key}\n`
          : `  ${c.red('✗')} ${r.key}: ${res.stderr.trim() || res.stdout.trim()}\n`
      );
    }
    process.stdout.write(
      muted('\n  Restart Ollama (quit it from the tray and reopen) for these to take effect.\n')
    );
  } else {
    const rcFile = join(process.env.HOME ?? '.', shellRc());
    const lines = recs.map((r) => `export ${r.key}=${r.value}`).join('\n');
    const block = `\n# nave-code: Ollama GPU tuning\n${lines}\n`;
    const current = existsSync(rcFile) ? readFileSync(rcFile, 'utf8') : '';
    if (!current.includes('# nave-code: Ollama GPU tuning')) {
      writeFileSync(rcFile, current + block, 'utf8');
      process.stdout.write(`  ${c.green('✓')} appended to ${rcFile}\n`);
    } else {
      process.stdout.write(muted(`  · ${rcFile} already has a nave block — edit it by hand\n`));
    }
    process.stdout.write(
      muted(`\n  Restart the Ollama service so it inherits them:\n    systemctl restart ollama   ${muted('# or relaunch "ollama serve"')}\n`)
    );
  }
  return 0;
}

function shellRc(): string {
  const shell = process.env.SHELL ?? '';
  if (shell.includes('zsh')) return '.zshrc';
  if (shell.includes('fish')) return '.config/fish/config.fish';
  return '.bashrc';
}

function cmdAgents(services: Services, cli: Cli): number {
  if (cli.rest[0] === 'new') {
    const name = cli.rest[1];
    if (!name) {
      process.stderr.write('Usage: nave agents new <name>\n');
      return 1;
    }
    const dir = cli.flags.user ? userPaths.agents : projectPaths(services.cwd).agents;
    ensureDir(dir);
    const file = join(dir, `${name}.md`);
    if (existsSync(file)) {
      process.stderr.write(`${file} already exists\n`);
      return 1;
    }
    writeFileSync(file, agentTemplate(name), 'utf8');
    process.stdout.write(
      `${accent('✓')} created ${c.bold(file)}\n${muted('  edit it, then delegate to it with the task tool')}\n`
    );
    return 0;
  }

  const agents = allAgents(services.cwd, true);
  process.stdout.write(
    [
      heading(`Agents (${agents.length})`),
      table(
        agents.map((a) => [
          c.bold(a.name),
          muted(a.role),
          a.model ?? muted(services.router.pick(a.role)?.model ?? '—'),
          a.source === 'builtin' ? muted('built-in') : accent('custom'),
          a.description,
        ]),
        ['NAME', 'ROLE', 'MODEL', 'SOURCE', 'PURPOSE']
      ),
      '',
      muted(`Create one: nave agents new <name>  (add --user for ${userPaths.agents})`),
      '',
    ].join('\n')
  );
  return 0;
}

async function cmdSession(services: Services, cli: Cli): Promise<number> {
  const agentName = String(cli.flags.agent ?? 'orchestrator');
  const modelOverride =
    typeof cli.flags.model === 'string'
      ? cli.flags.model
      : typeof cli.flags.m === 'string'
        ? cli.flags.m
        : undefined;

  let session: Session | null = null;
  if (cli.flags.continue || cli.flags.c) {
    session = Session.latest(services.cwd);
    if (session) process.stdout.write(muted(`continuing session ${session.id}\n`));
  } else if (typeof cli.flags.resume === 'string') {
    session = Session.load(services.cwd, cli.flags.resume);
    if (!session) {
      process.stderr.write(`No session "${cli.flags.resume}" in this project.\n`);
      return 1;
    }
  }
  if (!session) session = new Session(services.cwd);
  session.enablePersistence();

  const printPrompt =
    typeof cli.flags.p === 'string'
      ? cli.flags.p
      : typeof cli.flags.print === 'string'
        ? cli.flags.print
        : cli.flags.p || cli.flags.print
          ? cli.rest.join(' ')
          : null;

  // Headless: one turn, answer on stdout, no prompts.
  if (printPrompt !== null) {
    if (!printPrompt.trim()) {
      process.stderr.write('nave -p needs a prompt.\n');
      return 1;
    }
    const permissions = new Permissions(services.config, null);
    const controller = new AbortController();
    process.on('SIGINT', () => controller.abort());
    const result = await executeTurn(
      printPrompt,
      {
        services,
        session,
        permissions,
        todos: new TodoList(),
        readFiles: new Set(),
        agentName,
        modelOverride,
        quiet: true,
        verbose: Boolean(cli.flags.verbose),
      },
      controller.signal
    );
    if (result.stoppedBecause === 'error') {
      process.stderr.write(`${result.error ?? 'unknown error'}\n`);
      return 1;
    }
    return 0;
  }

  return runRepl({
    services,
    session,
    agentName,
    modelOverride,
    initialPrompt: cli.rest.length ? cli.rest.join(' ') : undefined,
  });
}

function usage(): string {
  const cmds: Array<[string, string]> = [
    ['nave', 'start an interactive session in this directory'],
    ['nave "<prompt>"', 'start a session with an opening request'],
    ['nave -p "<prompt>"', 'run one turn and print the answer (scriptable)'],
    ['nave init', 'set up NAVE.md and project memory here'],
    ['nave doctor', 'check Ollama, models, GPU, skills and memory'],
    ['nave models', 'list installed models and how nave rates them'],
    ['nave gpu [--apply]', 'GPU report, VRAM plan and server tuning'],
    ['nave memory [...]', 'inspect this project\'s memory'],
    ['nave skills [query]', 'list or search the skill library'],
    ['nave agents [new <n>]', 'list agents or scaffold a new one'],
    ['nave pull <model>', 'download a model from the Ollama registry'],
    ['nave config [...]', 'read or change settings'],
    ['nave sessions', 'list past sessions in this project'],
  ];
  const flags: Array<[string, string]> = [
    ['-m, --model <name>', 'use a specific Ollama model'],
    ['--agent <name>', 'start with a different agent (default: orchestrator)'],
    ['-c, --continue', 'continue the most recent session here'],
    ['--resume <id>', 'resume a specific session'],
    ['--plan', 'read-only: investigate and propose, change nothing'],
    ['--accept-edits', 'apply file edits without asking (commands still prompt)'],
    ['-y, --yes', 'never prompt for permission'],
    ['--allow <rules>', 'comma-separated permission rules, e.g. "bash(npm *)"'],
    ['--thinking', 'show the model\'s reasoning when it has any'],
    ['--cwd <dir>', 'work in a different directory'],
    ['--no-color', 'disable colour'],
  ];
  return [
    banner('everything runs on your machine — no API key, no bill'),
    `  ${c.bold('Usage')}`,
    ...cmds.map(([cmd, desc]) => `    ${accent(cmd.padEnd(24))} ${muted(desc)}`),
    '',
    `  ${c.bold('Options')}`,
    ...flags.map(([f, desc]) => `    ${accent(f.padEnd(24))} ${muted(desc)}`),
    '',
    `  ${muted('Inside a session, /help lists the commands. Everything runs locally through Ollama.')}`,
    '',
  ].join('\n');
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(errorBox('nave crashed', String((err as Error)?.stack ?? err)) + '\n');
    process.exitCode = 1;
  });
