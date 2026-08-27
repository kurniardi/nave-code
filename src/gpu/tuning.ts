import type { GpuReport } from './detect.ts';
import type { NaveConfig } from '../config/config.ts';
import type { ModelProfile } from '../providers/types.ts';

export interface RuntimePlan {
  /** Ollama options to send with every request for this model. */
  options: Record<string, unknown>;
  numCtx: number;
  numGpu: number | undefined;
  numBatch: number;
  kvCacheType: string;
  flashAttention: boolean;
  /** True when weights + KV cache are expected to sit entirely in VRAM. */
  fitsFully: boolean;
  estWeightsMb: number;
  estKvMb: number;
  estOverheadMb: number;
  budgetMb: number;
  notes: string[];
}

const BYTES_PER_ELEM: Record<string, number> = {
  f16: 2,
  q8_0: 1.0625,
  q4_0: 0.5625,
};

/**
 * KV-cache cost of a single token, in bytes, for one model.
 *
 * Derived from the GGUF metadata Ollama exposes on /api/show. When a field is
 * missing we fall back to a deliberately pessimistic estimate — running out of
 * VRAM mid-generation is far worse than leaving a little on the table.
 */
export function kvBytesPerToken(
  profile: ModelProfile,
  cacheType: string
): number {
  const elem = BYTES_PER_ELEM[cacheType] ?? 2;
  const layers = profile.blockCount ?? guessLayers(profile.paramsB);
  const heads = profile.headCount ?? 32;
  const kvHeads = profile.headCountKv ?? heads;
  const headDim =
    profile.keyLength ??
    (profile.embeddingLength ? profile.embeddingLength / heads : 128);
  // 2 = one K tensor plus one V tensor.
  return 2 * layers * kvHeads * headDim * elem;
}

function guessLayers(paramsB: number | null): number {
  if (!paramsB) return 32;
  if (paramsB <= 2) return 24;
  if (paramsB <= 4) return 28;
  if (paramsB <= 9) return 32;
  if (paramsB <= 16) return 40;
  if (paramsB <= 35) return 48;
  return 64;
}

export interface PlanInput {
  profile: ModelProfile;
  gpu: GpuReport;
  config: NaveConfig;
  /** Context the caller actually wants; the plan may shrink it to fit. */
  desiredCtx?: number;
  /**
   * VRAM this very model already occupies. The driver reports it as *used*,
   * but it is ours to reuse — without this, every run after the first sees a
   * shrunken budget and needlessly offloads layers to the CPU.
   */
  residentMb?: number;
}

export function planRuntime(input: PlanInput): RuntimePlan {
  const { profile, gpu, config } = input;
  const notes: string[] = [];
  const g = config.gpu;

  const hasGpu = gpu.gpus.length > 0 && gpu.totalVramMb > 0;
  const primary = gpu.gpus[0];

  // Prefer *free* VRAM when the driver reports it: the desktop compositor and
  // any already-resident model are real competitors for the same memory.
  const physicalMb = hasGpu
    ? (primary?.unified ? primary.totalMb : gpu.totalVramMb)
    : 0;
  const resident = input.residentMb ?? 0;
  const freeMb = primary?.freeMb !== null && primary?.freeMb !== undefined
    ? Math.min(physicalMb, primary.freeMb + resident)
    : null;
  const rawBudget = g.vramBudgetMb ?? (freeMb !== null ? freeMb : physicalMb);
  const budgetMb = Math.max(0, rawBudget - g.reserveMb);

  if (g.vramBudgetMb) {
    notes.push(`VRAM budget pinned to ${g.vramBudgetMb} MB by config`);
  } else if (freeMb !== null) {
    notes.push(
      resident > 0
        ? `using ${freeMb} MB VRAM (free, plus the ${resident} MB ${profile.name} already holds) minus ${g.reserveMb} MB reserve`
        : `using free VRAM (${freeMb} MB) minus ${g.reserveMb} MB reserve`
    );
  }

  const estWeightsMb = profile.sizeMb ?? estimateWeightsMb(profile);
  const kvType = g.flashAttention ? g.kvCacheType : 'f16';
  if (!g.flashAttention && g.kvCacheType !== 'f16') {
    notes.push('KV-cache quantisation needs flash attention; falling back to f16');
  }

  const perToken = kvBytesPerToken(profile, kvType);
  const numBatch = pickBatch(budgetMb);
  const estOverheadMb = computeOverheadMb(profile, numBatch);

  const modelMax = profile.contextLength ?? 8192;
  const ceiling = Math.min(g.maxContext, modelMax, input.desiredCtx ?? g.maxContext);

  let numCtx = ceiling;
  let numGpu: number | undefined;
  let fitsFully = true;

  if (!hasGpu) {
    notes.push('no GPU detected — running on CPU, keeping context small');
    numCtx = Math.min(ceiling, 8192);
    fitsFully = false;
    return assemble({
      numCtx, numGpu: 0, numBatch, kvType, config, notes, fitsFully,
      estWeightsMb, estKvMb: mb(perToken * numCtx), estOverheadMb, budgetMb,
    });
  }

  if (!g.autoTune) {
    notes.push('auto-tuning disabled (gpu.autoTune=false)');
    return assemble({
      numCtx, numGpu, numBatch, kvType, config, notes, fitsFully,
      estWeightsMb, estKvMb: mb(perToken * numCtx), estOverheadMb, budgetMb,
    });
  }

  const kvRoom = budgetMb - estWeightsMb - estOverheadMb;

  if (kvRoom > 0) {
    const maxCtxByVram = Math.floor((kvRoom * 1024 * 1024) / perToken);
    if (maxCtxByVram < numCtx) {
      const shrunk = clampCtx(maxCtxByVram, g.minContext, ceiling);
      if (shrunk < numCtx) {
        notes.push(
          `context trimmed ${numCtx} to ${shrunk} so weights + KV fit in ${budgetMb} MB`
        );
        numCtx = shrunk;
      }
    }
    const kvMb = mb(perToken * numCtx);
    if (estWeightsMb + kvMb + estOverheadMb > budgetMb) {
      fitsFully = false;
    }
  } else {
    fitsFully = false;
  }

  if (!fitsFully) {
    // Weights alone exceed the budget: offload the layers that do fit.
    numCtx = clampCtx(numCtx, g.minContext, Math.min(ceiling, g.minContext * 2));
    const layers = profile.blockCount ?? guessLayers(profile.paramsB);
    const perLayerMb = estWeightsMb / Math.max(1, layers);
    const kvMb = mb(perToken * numCtx);
    const room = budgetMb - estOverheadMb - kvMb;
    const fitLayers = Math.max(0, Math.floor(room / perLayerMb));

    if (!config.gpu.allowCpuOffload) {
      notes.push(
        `${profile.name} needs ~${Math.round(estWeightsMb + kvMb + estOverheadMb)} MB but only ${budgetMb} MB is free — ` +
          'CPU offload is disabled, so pick a smaller model or quant'
      );
    } else {
      numGpu = Math.min(layers, fitLayers);
      notes.push(
        `${profile.name} (~${Math.round(estWeightsMb)} MB) does not fit ${budgetMb} MB; ` +
          `offloading ${numGpu}/${layers} layers to GPU, rest on CPU (expect slower tokens/s)`
      );
    }
  }

  return assemble({
    numCtx, numGpu, numBatch, kvType, config, notes, fitsFully,
    estWeightsMb, estKvMb: mb(perToken * numCtx), estOverheadMb, budgetMb,
  });
}

interface AssembleArgs {
  numCtx: number;
  numGpu: number | undefined;
  numBatch: number;
  kvType: string;
  config: NaveConfig;
  notes: string[];
  fitsFully: boolean;
  estWeightsMb: number;
  estKvMb: number;
  estOverheadMb: number;
  budgetMb: number;
}

function assemble(a: AssembleArgs): RuntimePlan {
  const options: Record<string, unknown> = {
    num_ctx: a.numCtx,
    num_batch: a.numBatch,
    temperature: a.config.sampling.temperature,
    top_p: a.config.sampling.topP,
    repeat_penalty: a.config.sampling.repeatPenalty,
  };
  if (a.numGpu !== undefined) options.num_gpu = a.numGpu;
  if (a.config.sampling.seed !== undefined) options.seed = a.config.sampling.seed;

  return {
    options,
    numCtx: a.numCtx,
    numGpu: a.numGpu,
    numBatch: a.numBatch,
    kvCacheType: a.kvType,
    flashAttention: a.config.gpu.flashAttention,
    fitsFully: a.fitsFully,
    estWeightsMb: Math.round(a.estWeightsMb),
    estKvMb: Math.round(a.estKvMb),
    estOverheadMb: Math.round(a.estOverheadMb),
    budgetMb: Math.round(a.budgetMb),
    notes: a.notes,
  };
}

function clampCtx(v: number, min: number, max: number): number {
  const rounded = Math.floor(v / 512) * 512;
  return Math.max(min, Math.min(max, Math.max(512, rounded)));
}

function mb(bytes: number): number {
  return bytes / 1024 / 1024;
}

function pickBatch(budgetMb: number): number {
  if (budgetMb >= 20_000) return 1024;
  if (budgetMb >= 10_000) return 512;
  if (budgetMb >= 5_000) return 256;
  return 128;
}

function computeOverheadMb(profile: ModelProfile, numBatch: number): number {
  // CUDA context + compute graph + activation buffers. Scales with batch and,
  // loosely, with hidden size.
  const hidden = profile.embeddingLength ?? 4096;
  const base = 260;
  const activation = (hidden / 4096) * (numBatch / 512) * 320;
  return base + activation;
}

function estimateWeightsMb(profile: ModelProfile): number {
  const params = profile.paramsB ?? 7;
  const bpw = quantBitsPerWeight(profile.quantization);
  return (params * 1e9 * bpw) / 8 / 1024 / 1024;
}

export function quantBitsPerWeight(quant: string | null): number {
  if (!quant) return 4.7;
  const q = quant.toUpperCase();
  if (q.includes('F32')) return 32;
  if (q.includes('F16') || q.includes('BF16')) return 16;
  if (q.includes('Q8')) return 8.5;
  if (q.includes('Q6')) return 6.6;
  if (q.includes('Q5')) return 5.6;
  if (q.includes('Q4')) return 4.7;
  if (q.includes('Q3')) return 3.9;
  if (q.includes('Q2')) return 3.0;
  return 4.7;
}

/**
 * Server-level environment that materially changes Ollama's GPU behaviour.
 * These cannot be set per-request, so nave reports them and offers to apply.
 */
export function serverEnvRecommendations(
  config: NaveConfig
): Array<{ key: string; value: string; why: string }> {
  const recs: Array<{ key: string; value: string; why: string }> = [];
  if (config.gpu.flashAttention) {
    recs.push({
      key: 'OLLAMA_FLASH_ATTENTION',
      value: '1',
      why: 'cuts KV-cache memory and speeds up long contexts',
    });
    recs.push({
      key: 'OLLAMA_KV_CACHE_TYPE',
      value: config.gpu.kvCacheType,
      why: `stores the KV cache as ${config.gpu.kvCacheType} instead of f16 (roughly half the VRAM at q8_0)`,
    });
  }
  recs.push({
    key: 'OLLAMA_MAX_LOADED_MODELS',
    value: '1',
    why: 'keeps a second model from evicting the first on a small card',
  });
  recs.push({
    key: 'OLLAMA_NUM_PARALLEL',
    value: String(config.ollama.numParallel),
    why: 'each parallel slot multiplies KV-cache VRAM by one full context',
  });
  recs.push({
    key: 'OLLAMA_KEEP_ALIVE',
    value: config.ollama.keepAlive,
    why: 'avoids re-loading weights between turns',
  });
  return recs;
}
