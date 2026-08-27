import type { Tool } from './types.ts';
import { ok, fail, str } from './types.ts';
import { listAgentNames, describeAgents } from '../agents/loader.ts';

/**
 * Delegation. The orchestrator uses this to hand a bounded piece of work to a
 * sub-agent that gets its own context window and, usually, its own model — a
 * 3B model can sweep a directory for filenames while the 7B coder keeps its
 * context clean for the actual edit.
 */
export const taskTool: Tool = {
  name: 'task',
  description:
    'Delegate a self-contained piece of work to a sub-agent with its own context window and model. ' +
    'Use it when a step would flood your own context (searching a large codebase, reading many files, ' +
    'reviewing a diff) or needs a different specialism. ' +
    'The sub-agent cannot ask you questions, so give it everything it needs and say exactly what to report back.',
  readOnly: false,
  parameters: {
    type: 'object',
    properties: {
      agent: {
        type: 'string',
        description: 'Which agent to run. Call with an unknown name to see the list.',
      },
      prompt: {
        type: 'string',
        description:
          'The complete task. Include the goal, relevant paths, constraints, and the exact shape of the answer you want back.',
      },
      model: {
        type: 'string',
        description: 'Optional Ollama model override for this sub-agent.',
      },
    },
    required: ['agent', 'prompt'],
  },
  async run(args, ctx) {
    const agent = str(args, 'agent');
    const prompt = str(args, 'prompt');
    if (!agent) return fail(`agent is required. Available: ${listAgentNames(ctx.cwd).join(', ')}`);
    if (!prompt) return fail('prompt is required');

    if (!ctx.spawnAgent) {
      return fail('sub-agents are not available in this context');
    }
    if (ctx.depth >= ctx.services.config.agents.maxDepth) {
      return fail(
        `sub-agent depth limit (${ctx.services.config.agents.maxDepth}) reached — do this step yourself`
      );
    }

    const names = listAgentNames(ctx.cwd);
    if (!names.includes(agent)) {
      return fail(
        `unknown agent "${agent}".\n\nAvailable agents:\n${describeAgents(ctx.cwd)}`
      );
    }

    ctx.emit(`delegating to ${agent}: ${prompt.split('\n')[0].slice(0, 70)}`);
    const started = Date.now();
    try {
      const report = await ctx.spawnAgent({
        agent,
        prompt,
        model: str(args, 'model'),
      });
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      return ok(
        `Report from the ${agent} sub-agent:\n\n${report}`,
        `${agent} finished in ${secs}s`
      );
    } catch (err) {
      return fail(`the ${agent} sub-agent failed: ${(err as Error).message}`);
    }
  },
};
