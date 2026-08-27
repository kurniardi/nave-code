/**
 * How the context window is divided.
 *
 * The first version used fixed constants — a 24,000-character tool-result cap
 * and a system prompt allowed 45% of the window. On a 24k-token context that is
 * fine. On the 10k a 7B model gets from a 6 GB card it is fatal: the prompt and
 * tool schemas alone took 6,300 tokens, one file read could take 6,000 more, and
 * compaction fired on the first turn. Every limit here scales with the window.
 */

export interface ContextBudget {
  /** Total usable context for this model, as planned against VRAM. */
  total: number;
  /** Ceiling for the assembled system prompt, excluding tool schemas. */
  system: number;
  /** Ceiling for the JSON tool definitions. */
  schemas: number;
  /** Ceiling for a single tool result, in tokens. */
  toolResult: number;
  /** Left free for the model to generate into. */
  response: number;
  /** Compaction fires when the conversation passes this. */
  compactAt: number;
  /** Below this, nave trims descriptions and skips the skill catalogue. */
  tight: boolean;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

export function contextBudget(total: number, compactAtPercent = 80): ContextBudget {
  const tight = total < 16_384;

  const system = clamp(total * 0.18, 600, 3000);
  const schemas = clamp(total * 0.14, 500, 2800);
  const toolResult = clamp(total * 0.22, 400, 6000);
  const response = clamp(total * 0.12, 512, 4096);

  // Leave room for the reply: compaction must trigger before the window is so
  // full that there is nowhere to answer from.
  const ceiling = total - response;
  const compactAt = Math.min(ceiling, Math.round(total * (compactAtPercent / 100)));

  return { total, system, schemas, toolResult, response, compactAt, tight };
}

/** Characters, for the places that clip text rather than count tokens. */
export function tokensToChars(tokens: number): number {
  return Math.floor(tokens * 3.2);
}
