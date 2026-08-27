import type { Tool } from './types.ts';
import { ok, fail } from './types.ts';

export type TodoStatus = 'pending' | 'in_progress' | 'done';

export interface Todo {
  content: string;
  status: TodoStatus;
}

/**
 * A visible plan the model maintains as it works.
 *
 * Local models drift on long tasks far more than frontier ones do; an explicit
 * checklist they must rewrite each step is the cheapest correction available.
 */
export class TodoList {
  private items: Todo[] = [];

  get all(): Todo[] {
    return this.items;
  }

  get isEmpty(): boolean {
    return this.items.length === 0;
  }

  replace(items: Todo[]): void {
    this.items = items;
  }

  get summary(): string {
    if (!this.items.length) return 'no plan yet';
    const done = this.items.filter((t) => t.status === 'done').length;
    return `${done}/${this.items.length} done`;
  }

  render(): string {
    if (!this.items.length) return '(no todos)';
    return this.items
      .map((t) => {
        const box = t.status === 'done' ? '[x]' : t.status === 'in_progress' ? '[~]' : '[ ]';
        return `${box} ${t.content}`;
      })
      .join('\n');
  }
}

export const todoTool: Tool = {
  name: 'todo',
  description:
    'Record or update the task plan. Call it once when you start a multi-step task, then again ' +
    'after each step to mark progress. Send the complete list every time. ' +
    'Exactly one item may be in_progress.',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The full list, in order.',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'What the step does.' },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'done'],
              description: 'Current state of this step.',
            },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  async run(args, ctx) {
    const raw = args.todos;
    if (!Array.isArray(raw)) return fail('todos must be an array');

    const items: Todo[] = [];
    for (const entry of raw) {
      if (typeof entry === 'string') {
        items.push({ content: entry, status: 'pending' });
        continue;
      }
      if (!entry || typeof entry !== 'object') continue;
      const rec = entry as Record<string, unknown>;
      const content = String(rec.content ?? rec.task ?? rec.title ?? '').trim();
      if (!content) continue;
      const statusRaw = String(rec.status ?? 'pending').toLowerCase();
      const status: TodoStatus =
        statusRaw.startsWith('done') || statusRaw === 'completed'
          ? 'done'
          : statusRaw.startsWith('in')
            ? 'in_progress'
            : 'pending';
      items.push({ content, status });
    }

    if (!items.length) return fail('no valid todo items were provided');

    const active = items.filter((t) => t.status === 'in_progress');
    if (active.length > 1) {
      // Keep the first; demote the rest rather than rejecting the whole call.
      for (const t of active.slice(1)) t.status = 'pending';
    }

    ctx.todos.replace(items);
    ctx.emit(ctx.todos.render());
    return ok(
      `Plan updated (${ctx.todos.summary}):\n${ctx.todos.render()}`,
      `plan: ${ctx.todos.summary}`
    );
  },
};
