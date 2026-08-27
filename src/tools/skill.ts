import type { Tool } from './types.ts';
import { ok, fail, str } from './types.ts';
import { estimateTokens } from '../util/tokens.ts';

const MAX_SKILL_TOKENS = 6000;

/**
 * Skills are procedural knowledge the user already curated for Claude Code.
 * nave loads that same library, so a skill written once works in both.
 */
export const skillTool: Tool = {
  name: 'skill',
  description:
    'Load a skill: a set of instructions for a specific kind of task (design review, TDD, ' +
    'security scanning, a thinking framework, a deploy procedure, …). ' +
    'Use action "search" to find one by topic, then "load" to read it and follow it. ' +
    'Load a skill BEFORE starting the kind of work it covers, not after.',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['search', 'load', 'list'],
        description: 'search finds skills by topic; load reads one in full.',
      },
      name: { type: 'string', description: 'Exact skill name (for load).' },
      query: { type: 'string', description: 'What you are trying to do (for search).' },
    },
    required: ['action'],
  },
  async run(args, ctx) {
    const lib = ctx.services.skills;
    const action = (str(args, 'action') ?? 'search').toLowerCase();

    if (!lib.count) {
      return fail(
        'no skills are installed. nave reads skills from ' +
          `${ctx.services.config.skills.sources.join(', ')}.`
      );
    }

    if (action === 'list') {
      const lines = lib.all.map((s) => `- ${s.name}: ${clip(s.description, 110)}`);
      return ok(`${lib.count} skills available:\n${lines.join('\n')}`, `skill: ${lib.count} available`);
    }

    if (action === 'search') {
      const query = str(args, 'query') ?? str(args, 'name');
      if (!query) return fail('query is required for action "search"');
      const hits = lib.search(query, 8);
      if (!hits.length) {
        return ok(
          `No skill matches "${query}". Proceed without one.`,
          `skill: search "${query}" (0)`
        );
      }
      const lines = hits.map((s) => `- ${s.name}: ${clip(s.description, 200)}`);
      return ok(
        `Skills matching "${query}":\n${lines.join('\n')}\n\nLoad one with action "load".`,
        `skill: search "${query}" (${hits.length})`
      );
    }

    if (action === 'load') {
      const name = str(args, 'name');
      if (!name) return fail('name is required for action "load"');
      const found = lib.read(name);
      if (!found) {
        const near = lib.search(name, 3).map((s) => s.name);
        return fail(
          `no skill named "${name}"` + (near.length ? `. Closest: ${near.join(', ')}` : '')
        );
      }
      const { skill, body } = found;
      let text = body;
      if (estimateTokens(text) > MAX_SKILL_TOKENS) {
        text =
          `${text.slice(0, MAX_SKILL_TOKENS * 3)}\n\n…[skill truncated to fit the context window; ` +
          `the rest is at ${skill.file}]`;
      }
      ctx.emit(`loaded skill: ${skill.name}`);
      return ok(
        `# Skill: ${skill.name}\n\n${skill.description}\n\nFollow these instructions for this task.\n\n${text}` +
          `\n\n(Supporting files for this skill live in ${skill.dir} — read them with the read tool if referenced.)`,
        `skill: loaded ${skill.name}`
      );
    }

    return fail(`unknown action "${action}". Use search, load or list.`);
  },
};

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
