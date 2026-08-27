import type { Tool } from './types.ts';
import { ok, fail, str } from './types.ts';

/**
 * The exit from plan mode.
 *
 * Plan mode on its own is just read-only, which is half a feature: the model
 * investigates, writes a plan, and then the user has to copy it back in to get
 * anything built. This tool closes the loop — the plan is shown for approval,
 * and approving it drops the session into auto mode so the work starts
 * immediately, in the same turn, with the plan already in context.
 */
export const presentPlanTool: Tool = {
  name: 'present_plan',
  description:
    'Present your finished implementation plan to the user for approval. ' +
    'Call this only in plan mode, once you have read enough of the codebase to be specific. ' +
    'If the user approves, plan mode ends and you carry the plan out immediately.',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      plan: {
        type: 'string',
        description:
          'The plan as Markdown: numbered steps, the specific files each step touches, and how to verify it.',
      },
      summary: {
        type: 'string',
        description: 'One line describing what the plan achieves.',
      },
    },
    required: ['plan'],
  },
  async run(args, ctx) {
    const plan = str(args, 'plan');
    if (!plan || plan.trim().length < 20) {
      return fail('plan is required, and must be specific enough to act on');
    }
    if (ctx.permissions.currentMode !== 'plan') {
      return fail(
        'present_plan only applies in plan mode, and this session is not in it. Just do the work.'
      );
    }
    if (!ctx.ask) {
      return fail('there is no one to approve this plan in a non-interactive run');
    }

    const decision = await ctx.ask<'go' | 'auto' | 'revise'>({
      question: str(args, 'summary') ?? 'Ready to build this?',
      detail: plan.trim(),
      tone: 'plan',
      choices: [
        { key: 'y', label: 'Approve — build it', hint: 'edits apply, commands still ask', value: 'go' },
        { key: 'a', label: 'Approve — no more prompts', hint: 'runs to completion unattended', value: 'auto' },
        { key: 'n', label: 'Keep planning', hint: 'stay read-only and revise', value: 'revise' },
      ],
      fallback: 'revise',
    });

    if (decision === 'revise') {
      return ok(
        'The user did not approve the plan yet. Stay in plan mode: ask what they want changed, ' +
          'or investigate further. Do not modify anything.',
        'plan not approved'
      );
    }

    ctx.permissions.setMode(decision === 'auto' ? 'full' : 'acceptEdits');
    ctx.emit(
      decision === 'auto'
        ? 'plan approved — running unattended (full permissions)'
        : 'plan approved — edits apply automatically, commands still ask'
    );

    return ok(
      [
        'The user approved the plan. Plan mode is over and you can now change files.',
        '',
        'Carry out the plan you just presented, step by step, starting with the first step.',
        'Track progress with the todo tool, and verify your work before reporting back.',
      ].join('\n'),
      'plan approved'
    );
  },
};
