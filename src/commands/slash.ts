import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { c, accent, muted } from '../util/colors.ts';
import { heading, table, bar, errorBox } from '../ui/render.ts';
import { formatTokens } from '../util/tokens.ts';
import { formatMb } from '../gpu/detect.ts';
import { serverEnvRecommendations } from '../gpu/tuning.ts';
import { recommendedPulls } from '../providers/catalog.ts';
import { ROLES, saveConfig, setPath, getPath, coerceConfigValue } from '../config/config.ts';
import type { Role, PermissionMode } from '../config/config.ts';
import { userPaths, projectPaths } from '../config/paths.ts';
import { allAgents, invalidateAgents } from '../agents/loader.ts';
import { ALL_TOOLS } from '../tools/registry.ts';
import { Session } from '../session/session.ts';
import type { Services } from '../core/services.ts';
import type { Permissions } from '../session/permissions.ts';
import { parseFrontmatter } from '../util/frontmatter.ts';
import { writeProjectScaffold } from '../core/init.ts';

export interface SlashContext {
  services: Services;
  session: Session;
  permissions: Permissions;
  /** Replace the live session, e.g. for /clear. */
  setSession: (s: Session) => void;
  lastStats: { promptTokens: number; completionTokens: number; tps: number | null; steps: number } | null;
}

export interface SlashResult {
  /** Printed to the terminal. */
  output?: string;
  /** Fed back into the model as a user turn. */
  prompt?: string;
  exit?: boolean;
}

export interface SlashCommand {
  name: string;
  args?: string;
  summary: string;
  run(args: string, ctx: SlashContext): Promise<SlashResult> | SlashResult;
}

export const COMMANDS: SlashCommand[] = [
  {
    name: 'help',
    summary: 'Show every command',
    run(_args, ctx) {
      const rows = COMMANDS.map((cmd) => [
        accent(`/${cmd.name}${cmd.args ? ` ${cmd.args}` : ''}`),
        cmd.summary,
      ]);
      const custom = customCommands(ctx.services.cwd).map((cmd) => [
        accent(`/${cmd.name}`),
        `${cmd.summary} ${muted('(custom)')}`,
      ]);
      return {
        output: [
          heading('Commands'),
          table([...rows, ...custom]),
          '',
          muted('Anything not starting with / is sent to the model. Ctrl+C interrupts, Ctrl+D exits.'),
        ].join('\n'),
      };
    },
  },

  {
    name: 'models',
    summary: 'List installed Ollama models and how nave rates them',
    async run(args, ctx) {
      const { router } = ctx.services;
      await router.load(args.trim() === '--refresh');
      if (!router.models.length) {
        return { output: noModels(ctx.services) };
      }
      const rows = router.models.map((m) => {
        const plan = router.plan(m);
        const caps = [
          m.supportsTools ? c.green('tools') : muted('no tools'),
          m.supportsThinking ? c.cyan('thinking') : '',
          m.supportsVision ? c.magenta('vision') : '',
          m.isEmbedding ? muted('embedding') : '',
        ].filter(Boolean);
        return [
          c.bold(m.name),
          m.paramsB ? `${m.paramsB}B` : '—',
          m.quantization ?? '—',
          formatMb(m.sizeMb),
          plan.fitsFully ? c.green('fits GPU') : c.yellow('offloads'),
          `${formatTokens(plan.numCtx)} ctx`,
          caps.join(' '),
        ];
      });
      const assignments = ROLES.map((role) => {
        const pick = ctx.services.router.pick(role);
        return [accent(role), pick ? pick.model : muted('—'), muted(pick?.reason ?? 'no suitable model')];
      });
      return {
        output: [
          heading(`Installed models (${router.models.length})`),
          table(rows, ['MODEL', 'SIZE', 'QUANT', 'DISK', 'GPU FIT', 'CONTEXT', 'CAPABILITIES']),
          heading('Role assignments'),
          table(assignments, ['ROLE', 'MODEL', 'WHY']),
          '',
          muted('Pin one with /model <role> <name>. Rankings account for your VRAM.'),
        ].join('\n'),
      };
    },
  },

  {
    name: 'model',
    args: '[role] <name>',
    summary: 'Show or pin the model for a role',
    run(args, ctx) {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      if (!parts.length) {
        const rows = ROLES.map((role) => {
          const pick = ctx.services.router.pick(role);
          return [accent(role), pick?.model ?? muted('—'), pick?.explicit ? muted('pinned') : muted('auto')];
        });
        return { output: [heading('Model per role'), table(rows, ['ROLE', 'MODEL', 'SOURCE'])].join('\n') };
      }

      let role: Role = 'orchestrator';
      let name: string;
      if (parts.length >= 2 && (ROLES as string[]).includes(parts[0])) {
        role = parts[0] as Role;
        name = parts.slice(1).join(' ');
      } else {
        name = parts.join(' ');
        role = 'orchestrator';
      }

      const profile = ctx.services.router.get(name);
      if (!profile) {
        return {
          output: errorBox(
            'Model not installed',
            `"${name}" is not on this machine.`,
            `Pull it with "/pull ${name}", or run /models to see what you have.`
          ),
        };
      }

      ctx.services.config.models[role] = profile.name;
      const plan = ctx.services.router.plan(profile);
      const warn = plan.fitsFully
        ? c.green('fits entirely in VRAM')
        : c.yellow(`will offload to CPU — ${plan.notes[plan.notes.length - 1] ?? 'expect slower generation'}`);
      return {
        output: [
          `${accent('✓')} ${role} → ${c.bold(profile.name)} for this session`,
          `  ${formatTokens(plan.numCtx)} context, ${warn}`,
          muted(`  Make it permanent: /config set models.${role} ${profile.name}`),
        ].join('\n'),
      };
    },
  },

  {
    name: 'gpu',
    summary: 'GPU status, VRAM plan and Ollama server tuning',
    async run(_args, ctx) {
      const { gpu, router, client, config } = ctx.services;
      const out: string[] = [heading('GPU')];

      if (!gpu.gpus.length) {
        out.push(
          c.yellow('No GPU detected.'),
          muted(`Detection method: ${gpu.detectedBy}. Models will run on CPU — expect a few tokens per second.`)
        );
      } else {
        out.push(
          table(
            gpu.gpus.map((g) => [
              c.bold(g.name),
              g.vendor,
              formatMb(g.totalMb) + (g.unified ? muted(' unified') : ''),
              g.freeMb !== null ? `${formatMb(g.freeMb)} free` : muted('—'),
              g.driver ?? muted('—'),
            ]),
            ['DEVICE', 'VENDOR', 'MEMORY', 'AVAILABLE', 'DRIVER']
          )
        );
        out.push(muted(`  Detected via ${gpu.detectedBy}. System RAM: ${formatMb(gpu.systemRamMb)}.`));
      }

      const pick = router.pick('orchestrator');
      if (pick) {
        const plan = router.plan(pick.profile);
        const used = plan.estWeightsMb + plan.estKvMb + plan.estOverheadMb;
        out.push(heading(`Runtime plan for ${pick.model}`));
        out.push(
          table([
            ['weights', formatMb(plan.estWeightsMb)],
            ['KV cache', `${formatMb(plan.estKvMb)}  ${muted(`(${formatTokens(plan.numCtx)} ctx @ ${plan.kvCacheType})`)}`],
            ['compute buffers', formatMb(plan.estOverheadMb)],
            [c.bold('total'), c.bold(formatMb(used))],
            ['budget', `${formatMb(plan.budgetMb)}  ${bar(used / Math.max(1, plan.budgetMb))}`],
            ['GPU layers', plan.numGpu === undefined ? c.green('all') : c.yellow(String(plan.numGpu))],
            ['flash attention', plan.flashAttention ? c.green('on') : muted('off')],
          ])
        );
        for (const note of plan.notes) out.push(muted(`  · ${note}`));
      }

      try {
        const running = await client.ps();
        if (running.length) {
          out.push(heading('Loaded right now'));
          out.push(
            table(
              running.map((r) => [
                c.bold(r.name),
                formatMb(r.sizeMb),
                `${Math.round(r.gpuFraction * 100)}% on GPU`,
                r.gpuFraction < 0.99 ? c.yellow('partial offload') : c.green('fully resident'),
              ]),
              ['MODEL', 'SIZE', 'GPU', 'STATUS']
            )
          );
        }
      } catch {
        /* server may be down; the rest of the report still stands */
      }

      out.push(heading('Ollama server settings'));
      out.push(
        muted('These are server-wide and cannot be set per request. Set them where ollama serve runs:')
      );
      out.push(
        table(
          serverEnvRecommendations(config).map((r) => {
            const current = process.env[r.key];
            const state = current === r.value ? c.green('✓ set') : current ? c.yellow(`is ${current}`) : muted('unset');
            return [accent(r.key), c.bold(r.value), state, muted(r.why)];
          })
        )
      );
      out.push('', muted('Apply them for this machine with:  nave gpu --apply'));
      return { output: out.join('\n') };
    },
  },

  {
    name: 'memory',
    args: '[list|read <name>|rm <name>|search <q>]',
    summary: 'Inspect this project\'s durable memory',
    run(args, ctx) {
      const store = ctx.services.memory;
      const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const arg = rest.join(' ');

      if (!sub || sub === 'list') {
        const entries = store.list();
        if (!entries.length) {
          return {
            output: [
              muted('No project memory yet.'),
              muted('nave writes memories as it works, or ask it to: "remember that we use X because Y".'),
            ].join('\n'),
          };
        }
        return {
          output: [
            heading(`Project memory (${entries.length})`),
            table(
              entries.map((e) => [
                c.bold(e.name),
                muted(e.type),
                e.pinned ? accent('pinned') : '',
                e.description,
              ])
            ),
            '',
            muted(`Stored in ${store.dir} — commit it so your team shares the same context.`),
          ].join('\n'),
        };
      }

      if (sub === 'read' || sub === 'show') {
        const entry = store.get(arg);
        if (!entry) return { output: c.red(`No memory named "${arg}".`) };
        return {
          output: [
            heading(entry.title),
            muted(`${entry.type} · updated ${entry.updated}${entry.pinned ? ' · pinned' : ''}`),
            '',
            entry.body,
          ].join('\n'),
        };
      }

      if (sub === 'search') {
        const hits = store.search(arg, 8);
        if (!hits.length) return { output: muted(`Nothing matches "${arg}".`) };
        return {
          output: [
            heading(`Matches for "${arg}"`),
            table(hits.map((e) => [c.bold(e.name), e.description])),
          ].join('\n'),
        };
      }

      if (sub === 'rm' || sub === 'delete') {
        return {
          output: store.delete(arg)
            ? `${accent('✓')} deleted memory "${arg}"`
            : c.red(`No memory named "${arg}".`),
        };
      }

      return { output: muted('Usage: /memory [list|read <name>|search <query>|rm <name>]') };
    },
  },

  {
    name: 'agents',
    summary: 'List available agents',
    run(_args, ctx) {
      invalidateAgents();
      const agents = allAgents(ctx.services.cwd, true);
      const rows = agents.map((a) => {
        const pick = a.model ? null : ctx.services.router.pick(a.role);
        return [
          c.bold(a.name),
          muted(a.role),
          a.model ?? pick?.model ?? muted('—'),
          a.source === 'builtin' ? muted('built-in') : accent('custom'),
          a.description,
        ];
      });
      return {
        output: [
          heading(`Agents (${agents.length})`),
          table(rows, ['NAME', 'ROLE', 'MODEL', 'SOURCE', 'PURPOSE']),
          '',
          muted(`Add your own: a Markdown file in ${projectPaths(ctx.services.cwd).agents} or ${userPaths.agents}`),
          muted('Create one with: nave agents new <name>'),
        ].join('\n'),
      };
    },
  },

  {
    name: 'skills',
    args: '[query]',
    summary: 'List or search the skill library',
    run(args, ctx) {
      const lib = ctx.services.skills;
      if (!lib.count) {
        return {
          output: [
            c.yellow('No skills found.'),
            muted(`Looked in: ${ctx.services.config.skills.sources.join(', ')}`),
          ].join('\n'),
        };
      }
      const query = args.trim();
      const list = query ? lib.search(query, 20) : lib.all;
      return {
        output: [
          heading(query ? `Skills matching "${query}" (${list.length})` : `Skills (${lib.count})`),
          table(list.map((s) => [c.bold(s.name), truncateText(s.description, 90)])),
          '',
          muted(`Read from: ${lib.scanned.join(', ')}`),
          muted('The model loads these itself with the skill tool; you can also say "use the X skill".'),
        ].join('\n'),
      };
    },
  },

  {
    name: 'tools',
    summary: 'List the tools the model can call',
    run() {
      return {
        output: [
          heading(`Tools (${ALL_TOOLS.length})`),
          table(
            ALL_TOOLS.map((t) => [
              c.bold(t.name),
              t.readOnly ? c.green('read-only') : c.yellow('mutating'),
              truncateText(t.description, 84),
            ])
          ),
        ].join('\n'),
      };
    },
  },

  {
    name: 'permissions',
    args: '[ask|acceptEdits|plan|full]',
    summary: 'Show or change what nave may do without asking',
    run(args, ctx) {
      const mode = args.trim() as PermissionMode;
      const valid: PermissionMode[] = ['ask', 'acceptEdits', 'plan', 'full'];
      if (mode && valid.includes(mode)) {
        ctx.permissions.setMode(mode);
        return { output: `${accent('✓')} permission mode → ${c.bold(mode)}` };
      }
      if (mode) return { output: c.red(`Unknown mode "${mode}". Use one of: ${valid.join(', ')}`) };

      const rules = ctx.permissions.rules;
      return {
        output: [
          heading('Permissions'),
          `mode: ${c.bold(ctx.permissions.currentMode)}`,
          '',
          `${accent('ask')}         prompt before every write, edit or command`,
          `${accent('acceptEdits')} file changes are automatic, commands still prompt`,
          `${accent('plan')}        read-only: investigate and propose, change nothing`,
          `${accent('full')}        no prompts at all`,
          '',
          `allow: ${rules.allow.length ? rules.allow.join(', ') : muted('(none)')}`,
          `deny:  ${rules.deny.length ? rules.deny.join(', ') : muted('(none)')}`,
        ].join('\n'),
      };
    },
  },

  {
    name: 'context',
    summary: 'Show how full the context window is',
    run(_args, ctx) {
      const pick = ctx.services.router.pick('orchestrator');
      const plan = pick ? ctx.services.router.plan(pick.profile) : null;
      const used = ctx.session.tokens();
      const max = plan?.numCtx ?? 8192;
      const stats = ctx.lastStats;
      return {
        output: [
          heading('Context'),
          `${bar(used / max, 28)}  ${formatTokens(used)} / ${formatTokens(max)} tokens (${Math.round((used / max) * 100)}%)`,
          '',
          `messages: ${ctx.session.messages.length}    turns: ${ctx.session.turns}`,
          stats
            ? `last turn: ${stats.steps} step(s), ${formatTokens(stats.completionTokens)} generated${stats.tps ? ` at ${stats.tps.toFixed(1)} tok/s` : ''}`
            : muted('no completed turns yet'),
          '',
          muted(`Auto-compaction fires at ${ctx.services.config.ui.compactAtPercent}% — or force it now with /compact.`),
        ].join('\n'),
      };
    },
  },

  {
    name: 'compact',
    summary: 'Summarise the conversation so far to free context',
    async run(_args, ctx) {
      const before = ctx.session.tokens();
      const res = await ctx.session.compact(ctx.services, Math.floor(before * 0.5));
      if (!res) return { output: muted('Nothing to compact yet.') };
      return {
        output: `${accent('✓')} compacted ${formatTokens(res.before)} → ${formatTokens(res.after)} tokens`,
      };
    },
  },

  {
    name: 'clear',
    summary: 'Start a fresh conversation (project memory is kept)',
    run(_args, ctx) {
      const next = new Session(ctx.services.cwd);
      next.enablePersistence();
      ctx.setSession(next);
      return { output: `${accent('✓')} new session — project memory still applies` };
    },
  },

  {
    name: 'sessions',
    summary: 'List past sessions in this project',
    run(_args, ctx) {
      const metas = Session.list(ctx.services.cwd);
      if (!metas.length) return { output: muted('No saved sessions yet.') };
      return {
        output: [
          heading(`Sessions (${metas.length})`),
          table(
            metas
              .slice(0, 20)
              .map((m) => [c.bold(m.id), muted(m.created.slice(0, 16).replace('T', ' ')), `${m.turns} turns`, m.title]),
            ['ID', 'STARTED', 'TURNS', 'TITLE']
          ),
          '',
          muted('Resume the most recent with: nave --continue'),
        ].join('\n'),
      };
    },
  },

  {
    name: 'init',
    summary: 'Set up NAVE.md and project memory for this repo',
    async run(_args, ctx) {
      const created = writeProjectScaffold(ctx.services.cwd);
      return {
        output: [
          `${accent('✓')} project scaffolding ready`,
          ...created.map((f) => muted(`  ${f}`)),
          '',
          muted('Now ask nave to study the project — it will fill NAVE.md and write its first memories.'),
        ].join('\n'),
        prompt:
          'Study this project and set up its long-term context. ' +
          'Look at the README, the package/dependency manifests, the directory layout and a few representative source files. ' +
          'Then: (1) write NAVE.md with what this project is, how to build/test/run it, and the conventions its code actually follows; ' +
          '(2) record the durable facts as project memories with the memory tool — architecture, conventions and any non-obvious constraint. ' +
          'Keep both short and specific to this repo. Do not invent anything you have not verified in the files.',
      };
    },
  },

  {
    name: 'config',
    args: '[get <path>|set <path> <value>]',
    summary: 'Read or change nave settings',
    run(args, ctx) {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const [sub, path, ...rest] = parts;

      if (!sub || sub === 'show') {
        return {
          output: [
            heading('Configuration'),
            JSON.stringify(ctx.services.config, null, 2),
            '',
            muted(`Loaded from: ${ctx.services.configSources.join(', ') || 'defaults only'}`),
          ].join('\n'),
        };
      }
      if (sub === 'get') {
        if (!path) return { output: muted('Usage: /config get <path>') };
        return { output: `${accent(path)} = ${JSON.stringify(getPath(ctx.services.config, path))}` };
      }
      if (sub === 'set') {
        if (!path || !rest.length) return { output: muted('Usage: /config set <path> <value>') };
        const current = getPath(ctx.services.config, path);
        if (current === undefined) return { output: c.red(`Unknown setting "${path}".`) };
        let value: unknown;
        try {
          value = coerceConfigValue(current, rest.join(' '));
        } catch (err) {
          return { output: c.red(`${path}: ${(err as Error).message}`) };
        }
        const scope = join(ctx.services.cwd, '.nave', 'config.json');
        saveConfig(scope, setPath(path, value));
        return {
          output: [
            `${accent('✓')} ${path} = ${JSON.stringify(value)}`,
            muted(`  saved to ${scope} — restart nave for it to take effect`),
          ].join('\n'),
        };
      }
      return { output: muted('Usage: /config [show|get <path>|set <path> <value>]') };
    },
  },

  {
    name: 'pull',
    args: '<model>',
    summary: 'Download a model from the Ollama registry',
    async run(args, ctx) {
      const model = args.trim();
      if (!model) {
        const recs = recommendedPulls(ctx.services.gpu.totalVramMb || ctx.services.gpu.systemRamMb / 2);
        return {
          output: [
            heading('Recommended for your hardware'),
            table(recs.map((r) => [c.bold(r.model), muted(r.role), formatMb(r.approxVramMb), r.why])),
            '',
            muted('Pull one with /pull <model>. This is the only time nave touches the network.'),
          ].join('\n'),
        };
      }
      let lastPct = -1;
      process.stdout.write(muted(`pulling ${model}…\n`));
      await ctx.services.client.pull(model, (status, completed, total) => {
        if (total > 0) {
          const pct = Math.floor((completed / total) * 100);
          if (pct !== lastPct && pct % 5 === 0) {
            lastPct = pct;
            process.stdout.write(`\r  ${bar(completed / total, 24)} ${pct}%  ${muted(status)}   `);
          }
        }
      });
      process.stdout.write('\n');
      await ctx.services.router.load(true);
      return { output: `${accent('✓')} pulled ${c.bold(model)} — run /models to see how nave rates it` };
    },
  },

  {
    name: 'exit',
    summary: 'Leave nave',
    run() {
      return { exit: true };
    },
  },
];

export function findCommand(name: string): SlashCommand | null {
  const lower = name.toLowerCase();
  return (
    COMMANDS.find((cmd) => cmd.name === lower) ??
    COMMANDS.find((cmd) => cmd.name.startsWith(lower)) ??
    null
  );
}

/** User-authored prompt commands: .nave/commands/*.md and ~/.nave/commands/*.md */
export interface CustomCommand {
  name: string;
  summary: string;
  file: string;
  template: string;
}

export function customCommands(cwd: string): CustomCommand[] {
  const out = new Map<string, CustomCommand>();
  for (const dir of [userPaths.commands, projectPaths(cwd).commands]) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.md')) continue;
      const full = join(dir, file);
      try {
        const { data, body } = parseFrontmatter(readFileSync(full, 'utf8'));
        const name = String(data.name ?? file.replace(/\.md$/, ''));
        out.set(name, {
          name,
          summary: String(data.description ?? 'custom prompt'),
          file: full,
          template: body.trim(),
        });
      } catch {
        continue;
      }
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function expandCustomCommand(cmd: CustomCommand, args: string): string {
  return cmd.template
    .replace(/\$ARGUMENTS/g, args)
    .replace(/\$\{ARGUMENTS\}/g, args)
    .trim();
}

function noModels(services: Services): string {
  const recs = recommendedPulls(services.gpu.totalVramMb || 4000);
  return [
    c.yellow('No models are installed on the Ollama server.'),
    '',
    'Sized for your hardware:',
    ...recs.map((r) => `  ollama pull ${c.bold(r.model)}   ${muted(`${r.role} — ${r.why}`)}`),
  ].join('\n');
}

function truncateText(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= n ? flat : `${flat.slice(0, n - 1)}…`;
}
