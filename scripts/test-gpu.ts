/**
 * GPU ordering — which device the VRAM plan is built against.
 *
 * Everything downstream reads gpus[0], so the ordering is load-bearing: on a
 * hybrid laptop the OS enumerates the integrated GPU first, and planning
 * against that turns a 6 GB discrete card into 1 GB of shared memory.
 *
 *   node scripts/test-gpu.ts
 */
import { orderGpus } from '../src/gpu/detect.ts';
import type { GpuInfo } from '../src/gpu/detect.ts';

let failures = 0;

function assert(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const pass = a === e;
  if (!pass) failures++;
  process.stdout.write(
    pass ? `ok   ${name}\n` : `FAIL ${name}\n     expected ${e}\n     actual   ${a}\n`
  );
}

function gpu(name: string, totalMb: number, unified: boolean): GpuInfo {
  const vendor: GpuInfo['vendor'] = /nvidia|geforce/i.test(name)
    ? 'nvidia'
    : /intel|iris/i.test(name)
      ? 'intel'
      : 'unknown';
  return { vendor, name, totalMb, freeMb: null, usedMb: null, unified };
}

const names = (list: GpuInfo[]): string[] => list.map((g) => g.name);

process.stdout.write('\norderGpus\n\n');

{
  // The case that started this: Win32_VideoController hands back the iGPU
  // first, and the RTX has to win anyway.
  const iris = gpu('Intel(R) Iris(R) Xe Graphics', 1024, true);
  const rtx = gpu('NVIDIA GeForce RTX 3060 Laptop GPU', 6144, false);
  assert('a discrete card outranks an integrated one', names(orderGpus([iris, rtx])), [
    rtx.name,
    iris.name,
  ]);
}
{
  const iris = gpu('Intel(R) Iris(R) Xe Graphics', 1024, true);
  const rtx = gpu('NVIDIA GeForce RTX 3060 Laptop GPU', 6144, false);
  assert('an order that is already right is left alone', names(orderGpus([rtx, iris])), [
    rtx.name,
    iris.name,
  ]);
}
{
  const small = gpu('NVIDIA GeForce GTX 1650', 4096, false);
  const big = gpu('NVIDIA GeForce RTX 4090', 24_576, false);
  assert('between two discrete cards the larger wins', names(orderGpus([small, big])), [
    big.name,
    small.name,
  ]);
}
{
  // Apple reports one unified device; there is nothing to promote past it.
  const apple = gpu('Apple M3 Pro', 24_576, true);
  assert('a lone unified GPU stays put', names(orderGpus([apple])), [apple.name]);
}
{
  assert('no GPUs is not an error', orderGpus([]), []);
}
{
  const original = [
    gpu('Intel(R) Iris(R) Xe Graphics', 1024, true),
    gpu('NVIDIA GeForce RTX 3060 Laptop GPU', 6144, false),
  ];
  orderGpus(original);
  assert('the caller list is not reordered in place', names(original), [
    'Intel(R) Iris(R) Xe Graphics',
    'NVIDIA GeForce RTX 3060 Laptop GPU',
  ]);
}

process.stdout.write(failures ? `\n${failures} failing\n` : '\nall passing\n');
process.exitCode = failures ? 1 : 0;
