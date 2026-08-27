import { totalmem } from 'node:os';
import { run, which } from '../util/exec.ts';

export interface GpuInfo {
  vendor: 'nvidia' | 'amd' | 'intel' | 'apple' | 'unknown';
  name: string;
  totalMb: number;
  freeMb: number | null;
  usedMb: number | null;
  driver?: string;
  /** Apple Silicon and iGPUs share system RAM rather than owning VRAM. */
  unified: boolean;
}

export interface GpuReport {
  gpus: GpuInfo[];
  systemRamMb: number;
  detectedBy: string;
  /** Total dedicated VRAM across devices, in MiB. */
  totalVramMb: number;
}

let cached: GpuReport | null = null;

export async function detectGpus(force = false): Promise<GpuReport> {
  if (cached && !force) return cached;

  const systemRamMb = Math.round(totalmem() / 1024 / 1024);
  const nvidia = await detectNvidia();
  if (nvidia.length) {
    cached = finish(nvidia, systemRamMb, 'nvidia-smi');
    return cached;
  }

  const amd = await detectAmd();
  if (amd.length) {
    cached = finish(amd, systemRamMb, 'rocm-smi');
    return cached;
  }

  if (process.platform === 'darwin') {
    const apple = await detectApple(systemRamMb);
    if (apple.length) {
      cached = finish(apple, systemRamMb, 'system_profiler');
      return cached;
    }
  }

  if (process.platform === 'win32') {
    const win = await detectWindowsGeneric();
    if (win.length) {
      cached = finish(win, systemRamMb, 'CIM Win32_VideoController');
      return cached;
    }
  }

  cached = finish([], systemRamMb, 'none');
  return cached;
}

function finish(
  gpus: GpuInfo[],
  systemRamMb: number,
  detectedBy: string
): GpuReport {
  const totalVramMb = gpus
    .filter((g) => !g.unified)
    .reduce((sum, g) => sum + g.totalMb, 0);
  return { gpus, systemRamMb, detectedBy, totalVramMb };
}

async function detectNvidia(): Promise<GpuInfo[]> {
  if (!(await which('nvidia-smi'))) return [];
  const r = await run(
    'nvidia-smi',
    [
      '--query-gpu=name,memory.total,memory.free,memory.used,driver_version',
      '--format=csv,noheader,nounits',
    ],
    { timeoutMs: 8000 }
  );
  if (r.code !== 0) return [];
  return r.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, total, free, used, driver] = line
        .split(',')
        .map((s) => s.trim());
      return {
        vendor: 'nvidia' as const,
        name,
        totalMb: Number(total) || 0,
        freeMb: Number(free) || null,
        usedMb: Number(used) || null,
        driver,
        unified: false,
      };
    })
    .filter((g) => g.totalMb > 0);
}

async function detectAmd(): Promise<GpuInfo[]> {
  if (!(await which('rocm-smi'))) return [];
  const r = await run('rocm-smi', ['--showmeminfo', 'vram', '--json'], {
    timeoutMs: 8000,
  });
  if (r.code !== 0) return [];
  try {
    const data = JSON.parse(r.stdout) as Record<string, Record<string, string>>;
    const out: GpuInfo[] = [];
    for (const [card, fields] of Object.entries(data)) {
      const totalBytes = Number(
        fields['VRAM Total Memory (B)'] ?? fields['VRAM Total (B)'] ?? 0
      );
      const usedBytes = Number(
        fields['VRAM Total Used Memory (B)'] ?? fields['VRAM Used (B)'] ?? 0
      );
      if (!totalBytes) continue;
      const totalMb = Math.round(totalBytes / 1024 / 1024);
      const usedMb = Math.round(usedBytes / 1024 / 1024);
      out.push({
        vendor: 'amd',
        name: fields['Card series'] ?? fields['Card SKU'] ?? card,
        totalMb,
        freeMb: Math.max(0, totalMb - usedMb),
        usedMb,
        unified: false,
      });
    }
    return out;
  } catch {
    return [];
  }
}

async function detectApple(systemRamMb: number): Promise<GpuInfo[]> {
  const r = await run('system_profiler', ['SPDisplaysDataType', '-json'], {
    timeoutMs: 10_000,
  });
  if (r.code !== 0) return [];
  try {
    const data = JSON.parse(r.stdout) as {
      SPDisplaysDataType?: Array<Record<string, unknown>>;
    };
    return (data.SPDisplaysDataType ?? []).map((d) => ({
      vendor: 'apple' as const,
      name: String(d['sppci_model'] ?? 'Apple GPU'),
      // Metal can address roughly 70% of unified memory by default.
      totalMb: Math.round(systemRamMb * 0.7),
      freeMb: null,
      usedMb: null,
      unified: true,
    }));
  } catch {
    return [];
  }
}

async function detectWindowsGeneric(): Promise<GpuInfo[]> {
  const script =
    'Get-CimInstance Win32_VideoController | ' +
    'Select-Object Name,AdapterRAM,DriverVersion | ConvertTo-Json -Compress';
  const r = await run('powershell', ['-NoProfile', '-Command', script], {
    timeoutMs: 15_000,
  });
  if (r.code !== 0 || !r.stdout.trim()) return [];
  try {
    const parsed = JSON.parse(r.stdout) as unknown;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list
      .map((d) => {
        const rec = d as Record<string, unknown>;
        const name = String(rec.Name ?? 'GPU');
        // AdapterRAM is a signed 32-bit field and lies above 4 GB.
        const ramBytes = Number(rec.AdapterRAM ?? 0);
        const vendor: GpuInfo['vendor'] = /nvidia|geforce|rtx|quadro/i.test(name)
          ? 'nvidia'
          : /radeon|amd/i.test(name)
            ? 'amd'
            : /intel|arc|iris|uhd/i.test(name)
              ? 'intel'
              : 'unknown';
        return {
          vendor,
          name,
          totalMb: ramBytes > 0 ? Math.round(ramBytes / 1024 / 1024) : 0,
          freeMb: null,
          usedMb: null,
          driver: rec.DriverVersion ? String(rec.DriverVersion) : undefined,
          unified: vendor === 'intel',
        };
      })
      .filter((g) => g.totalMb > 0);
  } catch {
    return [];
  }
}

export function formatMb(mb: number | null | undefined): string {
  if (mb === null || mb === undefined) return '—';
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}
