import { writeFileSync, readFileSync, existsSync, readdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureDir, projectPaths } from '../config/paths.ts';
import { estimateMessagesTokens, estimateTokens } from '../util/tokens.ts';
import type { ChatMessage } from '../providers/types.ts';
import type { Services } from '../core/services.ts';

export interface SessionMeta {
  id: string;
  cwd: string;
  created: string;
  updated: string;
  title: string;
  model: string | null;
  turns: number;
}

interface Line {
  t: 'meta' | 'msg';
  meta?: SessionMeta;
  msg?: ChatMessage;
}

/**
 * A conversation, persisted as JSONL so `nave --continue` can pick it up.
 * Transcripts stay inside the project (.nave/sessions) and are gitignored:
 * memory is the part meant to be shared, not the raw log.
 */
export class Session {
  readonly id: string;
  readonly cwd: string;
  readonly created: string;
  messages: ChatMessage[] = [];
  title = '';
  model: string | null = null;
  private file: string | null = null;

  constructor(cwd: string, id?: string) {
    this.cwd = cwd;
    this.id = id ?? randomUUID().slice(0, 8);
    this.created = new Date().toISOString();
  }

  get systemPrompt(): string | null {
    const first = this.messages[0];
    return first?.role === 'system' ? first.content : null;
  }

  setSystem(text: string): void {
    if (this.messages[0]?.role === 'system') this.messages[0].content = text;
    else this.messages.unshift({ role: 'system', content: text });
  }

  add(msg: ChatMessage): void {
    this.messages.push(msg);
    if (!this.title && msg.role === 'user') {
      this.title = msg.content.split('\n')[0].slice(0, 70);
    }
    this.appendToDisk(msg);
  }

  get turns(): number {
    return this.messages.filter((m) => m.role === 'user').length;
  }

  tokens(): number {
    return estimateMessagesTokens(this.messages);
  }

  meta(): SessionMeta {
    return {
      id: this.id,
      cwd: this.cwd,
      created: this.created,
      updated: new Date().toISOString(),
      title: this.title || '(untitled)',
      model: this.model,
      turns: this.turns,
    };
  }

  enablePersistence(): void {
    const dir = projectPaths(this.cwd).sessions;
    ensureDir(dir);
    this.file = join(dir, `${this.id}.jsonl`);
    if (!existsSync(this.file)) {
      writeFileSync(this.file, JSON.stringify({ t: 'meta', meta: this.meta() }) + '\n', 'utf8');
    }
  }

  private appendToDisk(msg: ChatMessage): void {
    if (!this.file) return;
    try {
      appendFileSync(this.file, JSON.stringify({ t: 'msg', msg } satisfies Line) + '\n', 'utf8');
    } catch {
      // Losing a transcript line must never break the run.
    }
  }

  /**
   * Drop the oldest exchanges once the window fills, replacing them with a
   * summary. On a 6 GB card the context is small enough that this fires often,
   * so the summary explicitly preserves decisions and file paths.
   */
  async compact(services: Services, maxTokens: number): Promise<{ before: number; after: number; summary: string } | null> {
    const before = this.tokens();
    if (before < maxTokens) return null;

    const system = this.messages[0]?.role === 'system' ? this.messages[0] : null;
    const body = system ? this.messages.slice(1) : this.messages;
    if (body.length < 6) return null;

    // Keep the most recent exchanges verbatim; summarise everything older.
    const keep = Math.max(4, Math.floor(body.length * 0.3));
    const older = body.slice(0, body.length - keep);
    const recent = body.slice(body.length - keep);

    const transcript = older
      .map((m) => {
        const who = m.role === 'tool' ? `tool:${m.tool_name ?? ''}` : m.role;
        const calls = m.tool_calls?.map((c) => `${c.function.name}(${JSON.stringify(c.function.arguments).slice(0, 200)})`).join(', ');
        return `[${who}] ${clip(m.content, 1200)}${calls ? `\n  → called ${calls}` : ''}`;
      })
      .join('\n\n');

    const choice = services.router.pick('summarize') ?? services.router.pick('fast');
    let summary: string;

    if (!choice) {
      summary = `Earlier in this session (${older.length} messages) — transcript dropped, no summarisation model available.`;
    } else {
      const plan = services.router.plan(choice.profile);
      try {
        const res = await services.client.chat({
          model: choice.model,
          options: plan.options,
          messages: [
            {
              role: 'system',
              content:
                'You compress an agent transcript so work can continue without it. ' +
                'Preserve, in this order: what the user asked for; decisions made and why; ' +
                'every file created or modified, by path; commands run and their results; ' +
                'what is still unfinished. Drop everything else. No preamble, no commentary.',
            },
            { role: 'user', content: transcript },
          ],
        });
        summary = res.message.content.trim();
      } catch {
        summary = `Earlier in this session (${older.length} messages) — summarisation failed; transcript dropped.`;
      }
    }

    const summaryMsg: ChatMessage = {
      role: 'user',
      content: `[Summary of earlier work in this session]\n\n${summary}\n\n[End of summary — continue from here.]`,
    };

    this.messages = system ? [system, summaryMsg, ...recent] : [summaryMsg, ...recent];
    return { before, after: this.tokens(), summary };
  }

  static load(cwd: string, id: string): Session | null {
    const file = join(projectPaths(cwd).sessions, `${id}.jsonl`);
    if (!existsSync(file)) return null;
    const session = new Session(cwd, id);
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as Line;
        if (parsed.t === 'msg' && parsed.msg) session.messages.push(parsed.msg);
        if (parsed.t === 'meta' && parsed.meta) {
          session.title = parsed.meta.title;
          session.model = parsed.meta.model;
        }
      } catch {
        continue;
      }
    }
    session.file = file;
    return session;
  }

  static list(cwd: string): SessionMeta[] {
    const dir = projectPaths(cwd).sessions;
    if (!existsSync(dir)) return [];
    const out: SessionMeta[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.jsonl')) continue;
      try {
        // The meta header is written before the first turn, so title and turn
        // count are recovered from the transcript rather than trusted from it.
        const lines = readFileSync(join(dir, file), 'utf8').split('\n');
        let meta: SessionMeta | null = null;
        let turns = 0;
        let title = '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const parsed = JSON.parse(line) as Line;
          if (parsed.t === 'meta' && parsed.meta) meta = parsed.meta;
          if (parsed.t === 'msg' && parsed.msg?.role === 'user') {
            turns++;
            if (!title) title = parsed.msg.content.split('\n')[0].slice(0, 70);
          }
        }
        if (meta) out.push({ ...meta, turns, title: title || meta.title });
      } catch {
        continue;
      }
    }
    return out.sort((a, b) => b.created.localeCompare(a.created));
  }

  static latest(cwd: string): Session | null {
    const metas = Session.list(cwd);
    return metas.length ? Session.load(cwd, metas[0].id) : null;
  }
}

function clip(s: string, n: number): string {
  if (!s) return '';
  return s.length <= n ? s : `${s.slice(0, n)}… [${estimateTokens(s)} tokens]`;
}
