import type { ToolCall, ToolSpec } from '../providers/types.ts';

/**
 * Tool calling for models that do not support it natively.
 *
 * Ollama exposes a `tools` parameter only for models whose template declares
 * it. Plenty of good local models (older CodeLlama, most base models, some
 * community quants) do not. Rather than refuse them, nave falls back to a
 * text protocol: the tool list goes in the system prompt and calls are parsed
 * back out of the reply.
 */

const OPEN = '<tool_call>';
const CLOSE = '</tool_call>';

export function protocolInstructions(specs: ToolSpec[]): string {
  const lines = [
    '## Calling tools',
    '',
    'This model has no built-in tool support, so tools are called in text.',
    'To call a tool, emit exactly one block:',
    '',
    OPEN,
    '{"name": "read", "arguments": {"file_path": "src/index.ts"}}',
    CLOSE,
    '',
    'Rules:',
    '- The block must contain valid JSON with "name" and "arguments" keys.',
    '- Emit at most one tool call per reply, then stop and wait for the result.',
    '- Do not put a tool call inside a code fence.',
    '- When you have finished and need no more tools, reply with plain text only.',
    '',
    '### Tool definitions',
    '',
  ];
  for (const spec of specs) {
    const params = Object.entries(spec.function.parameters.properties ?? {})
      .map(([k, v]) => {
        const req = (spec.function.parameters.required ?? []).includes(k) ? ' (required)' : '';
        return `    ${k}: ${v.type}${req} — ${v.description ?? ''}`;
      })
      .join('\n');
    lines.push(`- ${spec.function.name}: ${spec.function.description}`);
    if (params) lines.push(params);
  }
  return lines.join('\n');
}

export interface ParsedProtocol {
  /** Text with the tool-call blocks removed. */
  text: string;
  calls: ToolCall[];
}

export function parseProtocol(raw: string): ParsedProtocol {
  const calls: ToolCall[] = [];
  let text = raw;

  // Primary form: explicit <tool_call> blocks.
  const blockRx = new RegExp(`${OPEN}([\\s\\S]*?)${CLOSE}`, 'g');
  text = text.replace(blockRx, (_m, body: string) => {
    const call = toCall(body);
    if (call) calls.push(call);
    return '';
  });

  // Tolerated form: a fenced json block that is obviously a call.
  if (!calls.length) {
    const fenceRx = /```(?:json|tool_call)?\s*(\{[\s\S]*?\})\s*```/g;
    text = text.replace(fenceRx, (m, body: string) => {
      const call = toCall(body);
      if (call) {
        calls.push(call);
        return '';
      }
      return m;
    });
  }

  // Last resort: a bare JSON object that has the right shape.
  if (!calls.length) {
    const trimmed = text.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      const call = toCall(trimmed);
      if (call) {
        calls.push(call);
        text = '';
      }
    }
  }

  return { text: text.trim(), calls };
}

function toCall(body: string): ToolCall | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Models sometimes trail a comma or wrap in prose; try the widest braces.
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      parsed = JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const rec = parsed as Record<string, unknown>;
  const name = rec.name ?? rec.tool ?? rec.function;
  if (typeof name !== 'string') return null;

  let rawArgs = rec.arguments ?? rec.args ?? rec.parameters ?? {};
  if (typeof rawArgs === 'string') {
    try {
      rawArgs = JSON.parse(rawArgs);
    } catch {
      rawArgs = {};
    }
  }
  return {
    function: {
      name,
      arguments: (rawArgs && typeof rawArgs === 'object'
        ? rawArgs
        : {}) as Record<string, unknown>,
    },
  };
}

/** True when a streamed chunk may be the start of a tool-call block. */
export function looksLikeProtocolStart(buffer: string): boolean {
  return OPEN.startsWith(buffer.slice(-OPEN.length)) || buffer.includes(OPEN);
}
