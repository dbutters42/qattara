// Shared setup for the headless GPU checks: the real sim modules
// (src/sim/*) running on Dawn — Google's WebGPU implementation, via the
// `webgpu` npm package — with no browser. On milliwaysserver Dawn falls back
// to a software Vulkan rasterizer.
//
// What it's for: correctness. Validation errors, mass conservation,
// negative values, whether terrain actually moves. What it's NOT for:
// performance — the software rasterizer is a poor proxy for a real GPU (it
// showed a 22 % gain where the iPad showed 6×). It also segfaults at field
// sizes ≥ 384², so keep scenarios ≤ 256².

import { create, globals } from 'webgpu';
import { createWaterSim, type WaterSim } from '../../src/sim/waterSim';
import { createErosionSim, type ErosionSim, type ErosionStats } from '../../src/sim/erosionSim';
import { createGpuTimer } from '../../src/diagnostics/gpuTimer';

Object.assign(globalThis, globals);

export const HEX_SIZE = 2;
export const TICK_DT = 1 / 30;
export const NO_SEA = -1e30;

export interface Terrain {
  rock: Float32Array;
  earth: Float32Array;
  sand: Float32Array;
}

export interface SimOptions {
  seaLevel?: number;
  springs?: { col: number; row: number; ratePerSecond?: number }[];
  rain?: boolean;
}

export interface Harness {
  n: number;
  sim: WaterSim;
  erosion: ErosionSim;
  /** Run `count` ticks, then wait for the GPU to finish. */
  run(count: number): Promise<void>;
  /** Run one tick and return conservation stats read back from it. */
  stats(): Promise<ErosionStats>;
  /** Read back the current earth/sand. */
  mirror(): Promise<{ earth: Float32Array; sand: Float32Array }>;
  /** GPU validation errors captured so far. */
  errors: string[];
}

// Held at module scope on purpose: if the Dawn instance gets garbage
// collected while its device is in use, the process segfaults.
const dawn = create([]);

export async function createHarness(n: number, terrain: Terrain, opts: SimOptions = {}): Promise<Harness> {
  const adapter = await dawn.requestAdapter();
  if (!adapter) throw new Error('Dawn found no WebGPU adapter');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (e) => errors.push((e as GPUUncapturedErrorEvent).error.message));

  const surface = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) surface[i] = terrain.rock[i]! + terrain.earth[i]! + terrain.sand[i]!;

  // Same format and usage as src/render/terrainPipeline.ts creates them.
  const texture = (data: Float32Array) => {
    const t = device.createTexture({
      size: { width: n, height: n },
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.STORAGE_BINDING,
    });
    device.queue.writeTexture({ texture: t }, data as Float32Array<ArrayBuffer>, { bytesPerRow: n * 4, rowsPerImage: n }, { width: n, height: n });
    return t;
  };
  const heightTexture = texture(surface);
  const earthTexture = texture(terrain.earth);
  const sandTexture = texture(terrain.sand);

  // The sims only use `gpu.device`.
  const gpu = { device } as unknown as Parameters<typeof createWaterSim>[0];
  const sim = createWaterSim(gpu, {
    fieldCols: n,
    fieldRows: n,
    hexSize: HEX_SIZE,
    heightTexture,
    initialWater: new Float32Array(n * n),
    initialSurfaceHeight: surface,
    seaLevel: opts.seaLevel ?? NO_SEA,
    springs: opts.springs ?? [],
  });
  sim.setRain(opts.rain ?? false);
  sim.setEvaporation(0);
  const erosion = createErosionSim(gpu, {
    fieldCols: n,
    fieldRows: n,
    hexSize: HEX_SIZE,
    heightTexture,
    earthTexture,
    sandTexture,
    rock: terrain.rock,
    earth: terrain.earth,
    sand: terrain.sand,
    water: sim,
  });
  const timer = createGpuTimer(device);

  function tick(): void {
    const encoder = device.createCommandEncoder();
    const bufs = sim.encode(encoder, TICK_DT);
    erosion.encode(encoder, TICK_DT, bufs, timer);
    device.queue.submit([encoder.finish()]);
    sim.afterSubmit();
    erosion.afterSubmit();
  }

  // Readback callbacks resolve on a later event-loop turn than the submit.
  async function settle<T>(get: () => T | null): Promise<T> {
    await device.queue.onSubmittedWorkDone();
    for (let k = 0; k < 100; k++) {
      const v = get();
      if (v !== null) return v;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('readback never arrived');
  }

  return {
    n,
    sim,
    erosion,
    errors,
    async run(count) {
      for (let k = 0; k < count; k++) tick();
      await device.queue.onSubmittedWorkDone();
    },
    async stats() {
      let got: ErosionStats | null = null;
      erosion.requestStats((s) => (got = s));
      // Stats wait for a slumping tick when slumping is on (≤ 4 ticks).
      for (let k = 0; k < 4 && got === null; k++) {
        tick();
        await device.queue.onSubmittedWorkDone();
        await new Promise((r) => setTimeout(r, 10));
      }
      return settle(() => got);
    },
    async mirror() {
      let got: { earth: Float32Array; sand: Float32Array } | null = null;
      erosion.requestMirror((earth, sand) => (got = { earth, sand }));
      tick();
      return settle(() => got);
    },
  };
}

// --- tiny assertion kit ---------------------------------------------------

let failures = 0;

export function check(ok: boolean, what: string, detail: string): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what} — ${detail}`);
  if (!ok) failures++;
}

/** Drift of (loose + exported) against a baseline, in percent. */
export function driftPct(s: ErosionStats, baseline: number): number {
  return ((s.looseVolume + s.exportedVolume - baseline) / baseline) * 100;
}

/** Rule of thumb from 06-m4-brief.md §0: under this is f32 noise; a broken clamp shows as whole percent. */
export const DRIFT_LIMIT_PCT = 1e-3;

export function finish(): never {
  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
