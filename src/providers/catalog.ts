import type { Role } from '../config/config.ts';

/**
 * What nave knows about model families, independent of what is installed.
 *
 * Scores are 0–10 affinities per role, hand-set from published benchmarks and
 * practical agent behaviour (instruction-following under a tool loop matters
 * more than raw benchmark score). Anything unmatched gets GENERIC.
 */
export interface FamilyKnowledge {
  id: string;
  label: string;
  /** Matched case-insensitively against the model tag. */
  match: RegExp;
  scores: Partial<Record<Role, number>>;
  notes?: string;
}

export const FAMILIES: FamilyKnowledge[] = [
  {
    id: 'qwen3-coder',
    label: 'Qwen3-Coder',
    match: /qwen3[.-]?coder/i,
    scores: { code: 10, review: 9, plan: 7, orchestrator: 8, explore: 8, fast: 5 },
    notes: 'strongest local coding family; native tool calling, long context',
  },
  {
    id: 'qwen2.5-coder',
    label: 'Qwen2.5-Coder',
    match: /qwen2\.?5[.-]?coder/i,
    scores: { code: 9, review: 8, plan: 6, orchestrator: 7, explore: 7, fast: 5 },
    notes: 'excellent edit/fill-in-middle quality for its size',
  },
  {
    id: 'devstral',
    label: 'Devstral',
    match: /devstral/i,
    scores: { code: 9, review: 8, orchestrator: 8, plan: 7, explore: 8 },
    notes: 'purpose-built for agentic coding loops',
  },
  {
    id: 'codestral',
    label: 'Codestral',
    match: /codestral/i,
    scores: { code: 9, review: 8, plan: 6, orchestrator: 6 },
  },
  {
    id: 'deepseek-coder',
    label: 'DeepSeek-Coder',
    match: /deepseek[.-]?coder/i,
    scores: { code: 9, review: 8, plan: 6, orchestrator: 5 },
  },
  {
    id: 'deepseek-r1',
    label: 'DeepSeek-R1',
    match: /deepseek[.-]?r1/i,
    scores: { plan: 9, review: 9, orchestrator: 7, code: 6, summarize: 6 },
    notes: 'reasoning-first; slow but strong at planning and critique',
  },
  {
    id: 'qwen3',
    label: 'Qwen3',
    match: /qwen3(?![.-]?coder)/i,
    scores: { orchestrator: 9, plan: 9, code: 8, review: 8, explore: 8, summarize: 8, fast: 6 },
    notes: 'best all-round local generalist with thinking + tools',
  },
  {
    id: 'qwen2.5',
    label: 'Qwen2.5',
    match: /qwen2\.?5(?![.-]?coder)/i,
    scores: { orchestrator: 8, plan: 7, code: 7, review: 7, explore: 7, summarize: 8, fast: 6 },
  },
  {
    id: 'glm',
    label: 'GLM',
    match: /glm[.-]?[45]/i,
    scores: { code: 8, orchestrator: 7, plan: 7, review: 7 },
  },
  {
    id: 'llama3',
    label: 'Llama 3.x',
    match: /llama[.-]?3/i,
    scores: { orchestrator: 7, plan: 7, code: 6, review: 6, explore: 7, summarize: 7, fast: 6 },
  },
  {
    id: 'mistral',
    label: 'Mistral / Mixtral',
    match: /mistral|mixtral|ministral/i,
    scores: { orchestrator: 7, code: 6, plan: 6, summarize: 7, explore: 7, fast: 7 },
  },
  {
    id: 'gemma',
    label: 'Gemma',
    match: /gemma/i,
    scores: { summarize: 8, explore: 7, plan: 6, code: 5, fast: 7, vision: 7 },
    notes: 'gemma3 handles images; weaker at tool loops',
  },
  {
    id: 'granite',
    label: 'Granite',
    match: /granite/i,
    scores: { code: 7, summarize: 7, orchestrator: 6, fast: 7 },
  },
  {
    id: 'phi',
    label: 'Phi',
    match: /\bphi[.-]?\d/i,
    scores: { fast: 8, summarize: 7, code: 6, plan: 5 },
    notes: 'small and quick; good for cheap summarisation passes',
  },
  {
    id: 'codellama',
    label: 'CodeLlama',
    match: /codellama|starcoder|codegemma/i,
    scores: { code: 6, review: 5 },
    notes: 'completion-oriented; usually lacks native tool calling',
  },
  {
    id: 'vision',
    label: 'Vision',
    match: /llava|bakllava|moondream|minicpm-?v|llama3\.2-vision/i,
    scores: { vision: 9, summarize: 5 },
  },
  {
    id: 'embed',
    label: 'Embedding',
    match: /embed|bge|minilm|e5-|gte-/i,
    scores: { embed: 10 },
  },
  {
    id: 'tiny',
    label: 'Tiny',
    match: /tinyllama|smollm|qwen.*0\.5b|gemma.*:2b/i,
    scores: { fast: 9, summarize: 5 },
  },
];

export const GENERIC: Partial<Record<Role, number>> = {
  orchestrator: 5,
  code: 5,
  plan: 5,
  review: 5,
  explore: 5,
  summarize: 5,
  fast: 5,
  vision: 0,
  embed: 0,
};

export function familyFor(modelName: string): FamilyKnowledge | null {
  for (const f of FAMILIES) if (f.match.test(modelName)) return f;
  return null;
}

export interface Recommendation {
  model: string;
  role: Role | 'general';
  why: string;
  approxVramMb: number;
}

/**
 * Pull suggestions sized to the card actually in the machine. nave never
 * downloads anything on its own — these are printed for the user to choose.
 */
export function recommendedPulls(vramMb: number): Recommendation[] {
  if (vramMb >= 22_000) {
    return [
      { model: 'qwen3-coder:30b', role: 'code', why: 'top local coding model at this tier', approxVramMb: 19_000 },
      { model: 'qwen3:14b', role: 'orchestrator', why: 'strong planner with thinking + tools', approxVramMb: 9_500 },
      { model: 'qwen3:4b', role: 'fast', why: 'cheap summarisation and compaction', approxVramMb: 3_000 },
      { model: 'nomic-embed-text', role: 'embed', why: 'memory search embeddings', approxVramMb: 400 },
    ];
  }
  if (vramMb >= 14_000) {
    return [
      { model: 'qwen2.5-coder:14b', role: 'code', why: 'best coding quality that still fits 16 GB', approxVramMb: 9_500 },
      { model: 'qwen3:8b', role: 'orchestrator', why: 'reliable tool-calling generalist', approxVramMb: 5_600 },
      { model: 'qwen3:4b', role: 'fast', why: 'cheap summarisation and compaction', approxVramMb: 3_000 },
      { model: 'nomic-embed-text', role: 'embed', why: 'memory search embeddings', approxVramMb: 400 },
    ];
  }
  if (vramMb >= 7_000) {
    return [
      { model: 'qwen2.5-coder:7b', role: 'code', why: 'fits 8 GB with room for a long context', approxVramMb: 4_700 },
      { model: 'qwen3:8b', role: 'orchestrator', why: 'tools + thinking in one model', approxVramMb: 5_600 },
      { model: 'qwen3:1.7b', role: 'fast', why: 'summaries without evicting the main model', approxVramMb: 1_400 },
      { model: 'nomic-embed-text', role: 'embed', why: 'memory search embeddings', approxVramMb: 400 },
    ];
  }
  if (vramMb >= 5_000) {
    return [
      { model: 'qwen2.5-coder:7b-instruct-q4_K_M', role: 'code', why: 'the largest coder that still leaves KV-cache room on 6 GB', approxVramMb: 4_700 },
      { model: 'qwen3:4b', role: 'orchestrator', why: 'tool calling that fits alongside a 16k context', approxVramMb: 3_000 },
      { model: 'qwen3:1.7b', role: 'fast', why: 'compaction pass that will not evict the coder', approxVramMb: 1_400 },
      { model: 'nomic-embed-text', role: 'embed', why: 'memory search embeddings, ~400 MB', approxVramMb: 400 },
    ];
  }
  return [
    { model: 'qwen3:4b', role: 'general', why: 'the practical floor for agentic tool use', approxVramMb: 3_000 },
    { model: 'qwen2.5-coder:3b', role: 'code', why: 'small but usable for focused edits', approxVramMb: 2_200 },
    { model: 'qwen3:1.7b', role: 'fast', why: 'summaries and routing', approxVramMb: 1_400 },
    { model: 'nomic-embed-text', role: 'embed', why: 'memory search embeddings', approxVramMb: 400 },
  ];
}
