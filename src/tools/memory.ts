import type { Tool } from './types.ts';
import { ok, fail, str, bool } from './types.ts';
import { MEMORY_TYPES } from '../memory/store.ts';
import type { MemoryType } from '../memory/store.ts';

/**
 * The model's own access to project memory.
 *
 * Writing is deliberately cheap and reading is deliberately explicit: the
 * index is always in the system prompt, so the model only pays for a full
 * entry when it decides the entry matters.
 */
export const memoryTool: Tool = {
  name: 'memory',
  description:
    'Read and write this project\'s durable memory — decisions, conventions, architecture notes and gotchas ' +
    'that must survive between sessions. ' +
    'Use action "read" before contradicting an indexed note, "search" to find relevant ones, and ' +
    '"write" when you learn something a future session would otherwise have to rediscover ' +
    '(a decision and its reason, a convention, a non-obvious constraint). ' +
    'Do not record things that are already obvious from the code.',
  readOnly: false,
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'read', 'search', 'write', 'delete'],
        description: 'What to do.',
      },
      name: {
        type: 'string',
        description: 'Short kebab-case identifier of the entry (for read, write, delete).',
      },
      query: { type: 'string', description: 'Search terms (for search).' },
      title: { type: 'string', description: 'Human-readable title (for write).' },
      description: {
        type: 'string',
        description: 'One line describing the entry; this is what future sessions see in the index.',
      },
      type: {
        type: 'string',
        enum: MEMORY_TYPES,
        description: 'Kind of memory (for write).',
      },
      body: {
        type: 'string',
        description:
          'The note itself (for write). State the fact, then why it is true, then how to apply it.',
      },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
      files: {
        type: 'array',
        items: { type: 'string' },
        description: 'Files this note is about, so it can be surfaced when they are touched.',
      },
      pinned: {
        type: 'boolean',
        description: 'Pinned entries are injected in full into every session. Use sparingly.',
      },
    },
    required: ['action'],
  },
  async run(args, ctx) {
    const store = ctx.services.memory;
    const action = (str(args, 'action') ?? 'list').toLowerCase();

    if (!ctx.services.config.memory.enabled) {
      return fail('project memory is disabled in this project (memory.enabled = false)');
    }

    switch (action) {
      case 'list': {
        const entries = store.list();
        if (!entries.length) return ok('No memories recorded for this project yet.', 'memory: empty');
        const lines = entries.map(
          (e) => `- ${e.name} (${e.type}${e.pinned ? ', pinned' : ''}) — ${e.description}`
        );
        return ok(`${entries.length} memories:\n${lines.join('\n')}`, `memory: ${entries.length} entries`);
      }

      case 'read': {
        const name = str(args, 'name');
        if (!name) return fail('name is required for action "read"');
        const entry = store.get(name);
        if (!entry) {
          const near = store.search(name, 3).map((e) => e.name);
          return fail(
            `no memory named "${name}"` +
              (near.length ? `. Closest: ${near.join(', ')}` : '')
          );
        }
        return ok(
          `# ${entry.title}\n(type: ${entry.type}, updated ${entry.updated})\n\n${entry.body}`,
          `memory: read ${entry.name}`
        );
      }

      case 'search': {
        const query = str(args, 'query') ?? str(args, 'name');
        if (!query) return fail('query is required for action "search"');
        const hits = store.search(query, 5);
        if (!hits.length) return ok(`No memories match "${query}".`, `memory: search "${query}" (0)`);
        const body = hits
          .map((e) => `## ${e.title} (${e.name})\n${e.description}\n\n${clip(e.body, 900)}`)
          .join('\n\n---\n\n');
        return ok(body, `memory: search "${query}" (${hits.length})`);
      }

      case 'write': {
        const name = str(args, 'name');
        const description = str(args, 'description');
        const body = str(args, 'body');
        if (!name) return fail('name is required for action "write"');
        if (!description) return fail('description is required — it is what the index shows');
        if (!body) return fail('body is required');

        const perm = await ctx.permissions.check({
          tool: 'memory',
          target: name,
          description: `Record project memory "${name}"`,
        });
        if (!perm.allowed) return fail(`memory write was not permitted — ${perm.reason}`);

        const typeRaw = str(args, 'type');
        const type = (MEMORY_TYPES as string[]).includes(typeRaw ?? '')
          ? (typeRaw as MemoryType)
          : undefined;

        const entry = store.write({
          name,
          title: str(args, 'title'),
          description,
          body,
          type,
          tags: toStrings(args.tags),
          files: toStrings(args.files),
          pinned: bool(args, 'pinned'),
        });
        ctx.emit(`remembered: ${entry.name} — ${entry.description}`);
        return ok(
          `Saved memory "${entry.name}" (${entry.type}). Future sessions in this project will see it in the index.`,
          `memory: wrote ${entry.name}`
        );
      }

      case 'delete': {
        const name = str(args, 'name');
        if (!name) return fail('name is required for action "delete"');
        const perm = await ctx.permissions.check({
          tool: 'memory',
          target: name,
          description: `Delete project memory "${name}"`,
          destructive: true,
        });
        if (!perm.allowed) return fail(`delete was not permitted — ${perm.reason}`);
        return store.delete(name)
          ? ok(`Deleted memory "${name}".`, `memory: deleted ${name}`)
          : fail(`no memory named "${name}"`);
      }

      default:
        return fail(`unknown action "${action}". Use list, read, search, write or delete.`);
    }
  },
};

function toStrings(v: unknown): string[] | undefined {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string' && v.trim()) {
    return v.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return undefined;
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
