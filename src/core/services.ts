import { loadConfig } from '../config/config.ts';
import type { NaveConfig } from '../config/config.ts';
import { OllamaClient } from '../providers/ollama.ts';
import { ModelRouter } from '../providers/router.ts';
import { detectGpus } from '../gpu/detect.ts';
import type { GpuReport } from '../gpu/detect.ts';
import { MemoryStore } from '../memory/store.ts';
import { SkillLibrary } from '../skills/loader.ts';
import { setColor } from '../util/colors.ts';

/** Everything a running nave session shares. Built once, passed everywhere. */
export interface Services {
  cwd: string;
  config: NaveConfig;
  configSources: string[];
  client: OllamaClient;
  router: ModelRouter;
  gpu: GpuReport;
  memory: MemoryStore;
  skills: SkillLibrary;
}

export interface BootOptions {
  cwd?: string;
  /** Skip talking to Ollama (for `nave config`, `nave memory`, …). */
  offline?: boolean;
  configOverrides?: Partial<NaveConfig>;
}

export async function boot(opts: BootOptions = {}): Promise<Services> {
  const cwd = opts.cwd ?? process.cwd();
  const { config, sources } = loadConfig(cwd);

  if (opts.configOverrides) Object.assign(config, opts.configOverrides);
  if (config.ui.color !== 'auto') setColor(config.ui.color === true);

  const gpu = await detectGpus();
  const client = new OllamaClient({
    host: config.ollama.host,
    keepAlive: config.ollama.keepAlive,
    requestTimeoutMs: config.ollama.requestTimeoutMs,
  });
  const router = new ModelRouter(client, config, gpu);

  const memory = new MemoryStore(cwd);
  const skills = new SkillLibrary(
    config.skills.enabled ? config.skills.sources : [],
    cwd
  );
  skills.load();

  if (!opts.offline) {
    await router.load();
  }

  return { cwd, config, configSources: sources, client, router, gpu, memory, skills };
}
