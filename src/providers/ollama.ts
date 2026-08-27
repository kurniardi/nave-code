import type {
  ChatDelta,
  ChatMessage,
  ChatRequest,
  ChatResult,
  ModelProfile,
  RunningModel,
  ToolCall,
} from './types.ts';

export class OllamaError extends Error {
  status: number | null;
  hint: string | null;
  constructor(message: string, status: number | null = null, hint: string | null = null) {
    super(message);
    this.name = 'OllamaError';
    this.status = status;
    this.hint = hint;
  }
}

export interface OllamaOptions {
  host: string;
  keepAlive: string;
  requestTimeoutMs: number;
}

export class OllamaClient {
  readonly host: string;
  readonly keepAlive: string;
  readonly timeoutMs: number;

  constructor(opts: OllamaOptions) {
    this.host = opts.host.replace(/\/+$/, '');
    this.keepAlive = opts.keepAlive;
    this.timeoutMs = opts.requestTimeoutMs;
  }

  private url(path: string): string {
    return `${this.host}${path}`;
  }

  private async request(
    path: string,
    init: RequestInit & { timeoutMs?: number } = {}
  ): Promise<Response> {
    const { timeoutMs, ...rest } = init;
    const timer = AbortSignal.timeout(timeoutMs ?? this.timeoutMs);
    const signal = rest.signal
      ? AbortSignal.any([rest.signal, timer])
      : timer;

    let res: Response;
    try {
      res = await fetch(this.url(path), { ...rest, signal });
    } catch (err) {
      throw this.connectionError(err);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new OllamaError(
        `Ollama returned ${res.status} for ${path}: ${text.slice(0, 400)}`,
        res.status,
        res.status === 404
          ? 'The model may not be pulled yet. Try: nave pull <model>'
          : null
      );
    }
    return res;
  }

  private connectionError(err: unknown): OllamaError {
    const msg = String((err as Error)?.message ?? err);
    if (/abort|timeout/i.test(msg)) {
      return new OllamaError(
        `Ollama did not respond within ${Math.round(this.timeoutMs / 1000)}s`,
        null,
        'A cold model load on a small GPU can be slow. Raise ollama.requestTimeoutMs, or run "nave gpu" to check for CPU offload.'
      );
    }
    return new OllamaError(
      `Cannot reach the Ollama server at ${this.host} (${msg})`,
      null,
      'Start it with "ollama serve", or point nave elsewhere with "nave config set ollama.host <url>".'
    );
  }

  async health(): Promise<{ ok: boolean; version: string | null; error?: string }> {
    try {
      const res = await this.request('/api/version', { timeoutMs: 4000 });
      const data = (await res.json()) as { version?: string };
      return { ok: true, version: data.version ?? null };
    } catch (err) {
      return { ok: false, version: null, error: (err as Error).message };
    }
  }

  async listRaw(): Promise<Array<Record<string, unknown>>> {
    const res = await this.request('/api/tags', { timeoutMs: 15_000 });
    const data = (await res.json()) as { models?: Array<Record<string, unknown>> };
    return data.models ?? [];
  }

  async show(name: string): Promise<Record<string, unknown>> {
    const res = await this.request('/api/show', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: name }),
      timeoutMs: 20_000,
    });
    return (await res.json()) as Record<string, unknown>;
  }

  async ps(): Promise<RunningModel[]> {
    const res = await this.request('/api/ps', { timeoutMs: 8000 });
    const data = (await res.json()) as { models?: Array<Record<string, unknown>> };
    return (data.models ?? []).map((m) => {
      const size = Number(m.size ?? 0);
      const vram = Number(m.size_vram ?? 0);
      return {
        name: String(m.name ?? m.model ?? ''),
        sizeMb: Math.round(size / 1024 / 1024),
        sizeVramMb: Math.round(vram / 1024 / 1024),
        expiresAt: m.expires_at ? String(m.expires_at) : null,
        gpuFraction: size > 0 ? vram / size : 0,
      };
    });
  }

  /** Free a model's VRAM immediately. */
  async unload(name: string): Promise<void> {
    await this.request('/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: name, keep_alive: 0 }),
      timeoutMs: 20_000,
    });
  }

  async embed(model: string, input: string | string[]): Promise<number[][]> {
    const res = await this.request('/api/embed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, input }),
      timeoutMs: 60_000,
    });
    const data = (await res.json()) as { embeddings?: number[][] };
    return data.embeddings ?? [];
  }

  async pull(
    model: string,
    onProgress?: (status: string, completed: number, total: number) => void
  ): Promise<void> {
    const res = await this.request('/api/pull', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
      timeoutMs: 60 * 60_000,
    });
    for await (const obj of streamJson(res)) {
      if (obj.error) throw new OllamaError(String(obj.error));
      onProgress?.(
        String(obj.status ?? ''),
        Number(obj.completed ?? 0),
        Number(obj.total ?? 0)
      );
    }
  }

  /**
   * Streaming chat. Deltas arrive through onDelta; the settled message and
   * timing stats come back in the result.
   */
  async chat(
    req: ChatRequest,
    onDelta?: (d: ChatDelta) => void
  ): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages.map(serialiseMessage),
      stream: true,
      keep_alive: req.keepAlive ?? this.keepAlive,
    };
    if (req.tools?.length) body.tools = req.tools;
    if (req.think) body.think = true;
    if (req.format) body.format = req.format;
    if (req.options) body.options = req.options;

    const res = await this.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: req.signal,
    });

    let content = '';
    let thinking = '';
    const toolCalls: ToolCall[] = [];
    let doneReason: string | null = null;
    let promptTokens = 0;
    let completionTokens = 0;
    let loadMs = 0;
    let promptMs = 0;
    let evalMs = 0;

    for await (const obj of streamJson(res)) {
      if (obj.error) throw new OllamaError(String(obj.error));
      const msg = obj.message as Record<string, unknown> | undefined;
      if (msg) {
        if (typeof msg.content === 'string' && msg.content) {
          content += msg.content;
          onDelta?.({ content: msg.content });
        }
        if (typeof msg.thinking === 'string' && msg.thinking) {
          thinking += msg.thinking;
          onDelta?.({ thinking: msg.thinking });
        }
        if (Array.isArray(msg.tool_calls)) {
          for (const raw of msg.tool_calls) {
            const call = normaliseToolCall(raw as Record<string, unknown>);
            if (call) {
              toolCalls.push(call);
              onDelta?.({ toolCall: call });
            }
          }
        }
      }
      if (obj.done) {
        doneReason = obj.done_reason ? String(obj.done_reason) : 'stop';
        promptTokens = Number(obj.prompt_eval_count ?? 0);
        completionTokens = Number(obj.eval_count ?? 0);
        loadMs = Number(obj.load_duration ?? 0) / 1e6;
        promptMs = Number(obj.prompt_eval_duration ?? 0) / 1e6;
        evalMs = Number(obj.eval_duration ?? 0) / 1e6;
        onDelta?.({ done: true });
      }
    }

    const message: ChatMessage = { role: 'assistant', content };
    if (thinking) message.thinking = thinking;
    if (toolCalls.length) message.tool_calls = toolCalls;

    return {
      message,
      model: req.model,
      doneReason,
      promptTokens,
      completionTokens,
      loadMs,
      promptMs,
      evalMs,
      tokensPerSecond:
        evalMs > 0 && completionTokens > 0
          ? completionTokens / (evalMs / 1000)
          : null,
    };
  }
}

function serialiseMessage(m: ChatMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: m.role, content: m.content };
  if (m.images?.length) out.images = m.images;
  if (m.tool_calls?.length) out.tool_calls = m.tool_calls;
  if (m.tool_name) out.tool_name = m.tool_name;
  if (m.thinking) out.thinking = m.thinking;
  return out;
}

function normaliseToolCall(raw: Record<string, unknown>): ToolCall | null {
  const fn = raw.function as Record<string, unknown> | undefined;
  if (!fn || typeof fn.name !== 'string') return null;
  let args: Record<string, unknown> = {};
  const rawArgs = fn.arguments;
  if (typeof rawArgs === 'string') {
    try {
      args = JSON.parse(rawArgs) as Record<string, unknown>;
    } catch {
      args = { _raw: rawArgs };
    }
  } else if (rawArgs && typeof rawArgs === 'object') {
    args = rawArgs as Record<string, unknown>;
  }
  return {
    id: typeof raw.id === 'string' ? raw.id : undefined,
    function: { name: fn.name, arguments: args },
  };
}

/** Ollama streams newline-delimited JSON. */
async function* streamJson(
  res: Response
): AsyncGenerator<Record<string, unknown>> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          yield JSON.parse(line) as Record<string, unknown>;
        } catch {
          // A partial frame; ignore and keep reading.
        }
      }
    }
    const tail = buffer.trim();
    if (tail) {
      try {
        yield JSON.parse(tail) as Record<string, unknown>;
      } catch {
        /* ignore trailing garbage */
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Turn /api/tags + /api/show payloads into a ModelProfile. */
export function buildProfile(
  tag: Record<string, unknown>,
  show: Record<string, unknown> | null
): ModelProfile {
  const details = (tag.details ?? {}) as Record<string, unknown>;
  const showDetails = (show?.details ?? {}) as Record<string, unknown>;
  const info = (show?.model_info ?? {}) as Record<string, unknown>;
  const caps = Array.isArray(show?.capabilities)
    ? (show!.capabilities as string[])
    : [];

  const name = String(tag.name ?? tag.model ?? '');
  const arch = String(info['general.architecture'] ?? details.family ?? '');
  const num = (suffix: string): number | null => {
    const key = Object.keys(info).find((k) => k.endsWith(suffix));
    if (!key) return null;
    const v = Number(info[key]);
    return Number.isFinite(v) ? v : null;
  };

  const paramSize = String(
    showDetails.parameter_size ?? details.parameter_size ?? ''
  );
  const paramsB = parseParamSize(paramSize) ?? parseParamsFromName(name);

  const sizeBytes = Number(tag.size ?? 0);

  return {
    name,
    digest: tag.digest ? String(tag.digest) : null,
    sizeMb: sizeBytes > 0 ? Math.round(sizeBytes / 1024 / 1024) : null,
    family: arch || null,
    families: Array.isArray(details.families)
      ? (details.families as string[])
      : arch
        ? [arch]
        : [],
    paramsB,
    quantization: String(
      showDetails.quantization_level ?? details.quantization_level ?? ''
    ) || null,
    contextLength: num('.context_length'),
    blockCount: num('.block_count'),
    headCount: num('.attention.head_count'),
    headCountKv: num('.attention.head_count_kv'),
    keyLength: num('.attention.key_length'),
    embeddingLength: num('.embedding_length'),
    capabilities: caps,
    supportsTools: caps.includes('tools'),
    supportsThinking: caps.includes('thinking'),
    supportsVision: caps.includes('vision'),
    isEmbedding: caps.includes('embedding') && !caps.includes('completion'),
    modifiedAt: tag.modified_at ? String(tag.modified_at) : null,
  };
}

function parseParamSize(s: string): number | null {
  const m = /([\d.]+)\s*([BM])/i.exec(s);
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v)) return null;
  return m[2].toUpperCase() === 'M' ? v / 1000 : v;
}

function parseParamsFromName(name: string): number | null {
  const m = /[:\-_](\d+(?:\.\d+)?)b\b/i.exec(name);
  return m ? Number(m[1]) : null;
}
