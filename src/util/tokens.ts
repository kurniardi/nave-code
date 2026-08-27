/**
 * Cheap, dependency-free token estimation.
 * Local models vary wildly in tokenizer, so nave budgets conservatively:
 * code and JSON tokenize denser than prose, so we use a blended ratio and
 * round up. Never used for billing (there is none) — only for context fit.
 */

const CHARS_PER_TOKEN_PROSE = 4.0;
const CHARS_PER_TOKEN_CODE = 3.2;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  // Heuristic: high punctuation/symbol density => code-like.
  const symbols = (text.match(/[{}()[\];:<>/\=+*&|_#$@`~"']/g) ?? []).length;
  const density = symbols / Math.max(1, text.length);
  const ratio =
    density > 0.06 ? CHARS_PER_TOKEN_CODE : CHARS_PER_TOKEN_PROSE;
  return Math.ceil(text.length / ratio);
}

export function estimateMessagesTokens(
  messages: Array<{ content?: string; thinking?: string; tool_calls?: unknown }>
): number {
  let total = 0;
  for (const m of messages) {
    total += 4; // per-message framing overhead
    if (m.content) total += estimateTokens(m.content);
    if (m.thinking) total += estimateTokens(m.thinking);
    if (m.tool_calls) total += estimateTokens(JSON.stringify(m.tool_calls));
  }
  return total;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
