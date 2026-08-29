import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { ensureDir, userPaths } from '../config/paths.ts';
import type { NaveConfig, Role } from '../config/config.ts';
import { OllamaClient, buildProfile } from './ollama.ts';
import type { ModelProfile, RunningModel } from './types.ts';
import { familyFor, GENERIC } from './catalog.ts';
import type { GpuReport } from '../gpu/detect.ts';
import { planRuntime, kvBytesPerToken } from '../gpu/tuning.ts';

export interface Scored {
  profile: ModelProfile;
  score: number;
  reasons: string[];
  fitsFully: boolean;
}

export interface Choice {
  model: string;
  profile: ModelProfile;
  reason: string;
  explicit: boolean;
}

interface CacheShape {
  version: number;
  entries: Record<string, ModelProfile>;
}

const CACHE_VERSION = 3;

/** Roles that are useless without a real tool-calling loop. */
const TOOL_ROLES = new Set<Role>(['orchestrator', 'code', 'explore', 'review']);
const THINKING_ROLES = new Set<Role>(['plan', 'review', 'orchestrator']);

export class ModelRouter {
  private profiles: ModelProfile[] = [];
  private byName = new Map<string, ModelProfile>();
  private loaded = false;
  /** model name → what /api/ps says it is doing right now. */
  private resident = new Map<string, RunningModel>();

  private client: OllamaClient;
  private config: NaveConfig;
  private gpu: GpuReport;

  constructor(client: OllamaClient, config: NaveConfig, gpu: GpuReport) {
    this.client = client;
    this.config = config;
    this.gpu = gpu;
  }

  get models(): ModelProfile[] {
    return this.profiles;
  }

  get ready(): boolean {
    return this.loaded;
  }

  async load(force = false): Promise<ModelProfile[]> {
    const tags = await this.client.listRaw();
    const cache = force ? { version: CACHE_VERSION, entries: {} } : readCache();
    const out: ModelProfile[] = [];
    let dirty = false;

    for (const tag of tags) {
      const name = String(tag.name ?? tag.model ?? '');
      if (!name) continue;
      const key = `${name}@${String(tag.digest ?? '')}`;
      const hit = cache.entries[key];
      if (hit) {
        out.push(hit);
        continue;
      }
      // /api/show is the only source of capabilities and GGUF metadata.
      let show: Record<string, unknown> | null = null;
      try {
        show = await this.client.show(name);
      } catch {
        show = null;
      }
      const profile = buildProfile(tag, show);
      cache.entries[key] = profile;
      dirty = true;
      out.push(profile);
    }

    if (dirty) writeCache(cache);

    this.profiles = out;
    this.byName = new Map(out.map((p) => [p.name, p]));
    this.loaded = true;
    await this.refreshResident();
    return out;
  }

  /** Which models are loaded right now, and how much VRAM each holds. */
  async refreshResident(): Promise<void> {
    try {
      const running = await this.client.ps();
      this.resident = new Map(running.map((r) => [r.name, r]));
    } catch {
      this.resident = new Map();
    }
  }

  private running(name: string): RunningModel | null {
    return this.resident.get(name) ?? this.resident.get(`${name}:latest`) ?? null;
  }

  residentMb(name: string): number {
    return this.running(name)?.sizeVramMb ?? 0;
  }

  /**
   * The share of a loaded model that is genuinely on the GPU, or null when it
   * is not loaded. Ollama measures this; `plan().fitsFully` only predicts it,
   * and the two disagree whenever the VRAM arithmetic was off.
   */
  residentGpuFraction(name: string): number | null {
    return this.running(name)?.gpuFraction ?? null;
  }

  get(name: string): ModelProfile | null {
    if (this.byName.has(name)) return this.byName.get(name)!;
    // Tolerate a missing ":latest" suffix and prefix matches.
    const withLatest = this.byName.get(`${name}:latest`);
    if (withLatest) return withLatest;
    const prefix = this.profiles.find((p) => p.name.startsWith(`${name}:`));
    return prefix ?? null;
  }

  /** Rank every installed model for a role, best first. */
  rank(role: Role): Scored[] {
    const scored = this.profiles
      .filter((p) => (role === 'embed' ? p.isEmbedding : !p.isEmbedding))
      .filter((p) => (role === 'vision' ? p.supportsVision : true))
      .map((p) => this.score(p, role))
      .sort((a, b) => b.score - a.score);
    return scored;
  }

  private score(profile: ModelProfile, role: Role): Scored {
    const reasons: string[] = [];
    const fam = familyFor(profile.name);
    const base = (fam?.scores ?? GENERIC)[role] ?? GENERIC[role] ?? 3;
    let score = base;
    reasons.push(`${fam?.label ?? 'unknown family'} affinity for ${role}: ${base}`);

    if (TOOL_ROLES.has(role)) {
      if (profile.supportsTools) {
        score += 4;
        reasons.push('native tool calling (+4)');
      } else {
        score -= 5;
        reasons.push('no native tool calling — needs the prompted fallback (-5)');
      }
    }
    if (THINKING_ROLES.has(role) && profile.supportsThinking) {
      score += 1.5;
      reasons.push('supports thinking (+1.5)');
    }

    // Size: bigger is better, but only while it fits in VRAM.
    // Must go through plan() so the already-resident model is credited back;
    // otherwise a loaded model is penalised for occupying its own memory.
    const plan = this.plan(profile);
    const params = profile.paramsB ?? 7;
    if (plan.fitsFully) {
      const sizeBonus = Math.min(3, Math.log2(Math.max(1, params)) * 0.8);
      score += sizeBonus;
      reasons.push(`~${params}B fits entirely in VRAM (+${sizeBonus.toFixed(1)})`);
    } else {
      score -= 4;
      reasons.push('does not fit in VRAM — would offload to CPU (-4)');
    }

    if (role === 'fast') {
      const speedBonus = Math.max(0, 3 - params / 3);
      score += speedBonus;
      reasons.push(`small enough to be quick (+${speedBonus.toFixed(1)})`);
    }

    // Usable context after the VRAM plan, not the model's advertised maximum.
    if (role === 'orchestrator' || role === 'plan') {
      if (plan.numCtx >= 32_768) {
        score += 1;
        reasons.push('32k+ usable context (+1)');
      } else if (plan.numCtx < 8192) {
        score -= 1;
        reasons.push(`only ${plan.numCtx} usable context (-1)`);
      }
    }

    if (/[:-](base|text)$/i.test(profile.name)) {
      score -= 2;
      reasons.push('base (non-instruct) model (-2)');
    }

    return { profile, score, reasons, fitsFully: plan.fitsFully };
  }

  /**
   * The model nave will actually use for a role.
   * Explicit config always wins, even over a better-scoring model.
   */
  pick(role: Role): Choice | null {
    const pinned = this.config.models[role] ?? this.config.models.default;
    if (pinned) {
      const p = this.get(pinned);
      if (p) {
        return {
          model: p.name,
          profile: p,
          reason: this.config.models[role]
            ? `pinned in config as models.${role}`
            : 'pinned in config as models.default',
          explicit: true,
        };
      }
    }
    const ranked = this.rank(role);
    const best = ranked[0];
    if (!best) return null;
    return {
      model: best.profile.name,
      profile: best.profile,
      reason: best.reasons.slice(0, 2).join('; '),
      explicit: false,
    };
  }

  /** Full runtime plan for a chosen model, including GPU-fitted context. */
  plan(profile: ModelProfile, desiredCtx?: number) {
    return planRuntime({
      profile,
      gpu: this.gpu,
      config: this.config,
      desiredCtx,
      residentMb: this.residentMb(profile.name),
    });
  }

  /** Largest context this model could run at, ignoring the configured cap. */
  maxUsableContext(profile: ModelProfile): number {
    const perToken = kvBytesPerToken(profile, this.config.gpu.kvCacheType);
    const budget =
      (this.config.gpu.vramBudgetMb ?? this.gpu.totalVramMb) -
      this.config.gpu.reserveMb -
      (profile.sizeMb ?? 0);
    if (budget <= 0) return this.config.gpu.minContext;
    return Math.min(
      profile.contextLength ?? 8192,
      Math.floor((budget * 1024 * 1024) / perToken)
    );
  }
}

function readCache(): CacheShape {
  if (!existsSync(userPaths.modelCache)) {
    return { version: CACHE_VERSION, entries: {} };
  }
  try {
    const parsed = JSON.parse(
      readFileSync(userPaths.modelCache, 'utf8')
    ) as CacheShape;
    if (parsed.version !== CACHE_VERSION) {
      return { version: CACHE_VERSION, entries: {} };
    }
    return parsed;
  } catch {
    return { version: CACHE_VERSION, entries: {} };
  }
}

function writeCache(cache: CacheShape): void {
  try {
    ensureDir(dirname(userPaths.modelCache));
    writeFileSync(
      userPaths.modelCache,
      JSON.stringify(cache, null, 2) + '\n',
      'utf8'
    );
  } catch {
    // A read-only home directory is not worth failing a run over.
  }
}
