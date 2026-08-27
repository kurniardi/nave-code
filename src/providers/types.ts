export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id?: string;
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface ChatMessage {
  role: MessageRole;
  content: string;
  /** Reasoning text from thinking-capable models, kept out of transcripts. */
  thinking?: string;
  /** Base64 images for vision models. */
  images?: string[];
  tool_calls?: ToolCall[];
  /** Set on role:'tool' messages so the model can match the response. */
  tool_name?: string;
}

export interface JsonSchema {
  type: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: unknown[];
  default?: unknown;
  [k: string]: unknown;
}

export interface ToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JsonSchema;
  };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  think?: boolean;
  format?: 'json' | Record<string, unknown>;
  options?: Record<string, unknown>;
  keepAlive?: string;
  signal?: AbortSignal;
}

export interface ChatDelta {
  content?: string;
  thinking?: string;
  toolCall?: ToolCall;
  done?: boolean;
}

export interface ChatResult {
  message: ChatMessage;
  model: string;
  doneReason: string | null;
  promptTokens: number;
  completionTokens: number;
  loadMs: number;
  promptMs: number;
  evalMs: number;
  tokensPerSecond: number | null;
}

/** Everything nave knows about one installed Ollama model. */
export interface ModelProfile {
  name: string;
  digest: string | null;
  sizeMb: number | null;
  family: string | null;
  families: string[];
  paramsB: number | null;
  quantization: string | null;
  contextLength: number | null;
  blockCount: number | null;
  headCount: number | null;
  headCountKv: number | null;
  keyLength: number | null;
  embeddingLength: number | null;
  capabilities: string[];
  supportsTools: boolean;
  supportsThinking: boolean;
  supportsVision: boolean;
  isEmbedding: boolean;
  modifiedAt: string | null;
}

export interface RunningModel {
  name: string;
  sizeMb: number;
  sizeVramMb: number;
  expiresAt: string | null;
  /** 0–1: how much of the loaded model actually sits in VRAM. */
  gpuFraction: number;
}
