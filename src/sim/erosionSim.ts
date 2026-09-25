import hexGridSrc from './hexGrid.wgsl?raw';
import shaderSrc from './erosion.wgsl?raw';
import type { GpuContext } from '../render/webgpu';
import type { BoundingBox } from '../interaction/brush';
import type { WaterSim, WaterTickBuffers } from './waterSim';
import type { GpuTimer } from '../diagnostics/gpuTimer';
import { edgeSlotCount } from './edgeGhost';

// M4 hydraulic erosion (docs/design/06-m4-brief.md). Owns the terrain on the
// GPU from creation onward — brief §4.1, the other half of D15's authority
// shift: `rock` / `earth` / `sand` live in storage buffers here, and each
// tick the erosion runs, cs_compose rewrites the height/earth/sand textures
// that the renderer and the water sim read. Nothing downstream changes how
// it reads.
//
// Brush edits still happen on the CPU (M2 untouched). After a stroke updates
// a region, `uploadRegion` copies exactly that rectangle into the buffers.
// The CPU copy is kept close to the GPU's by `requestMirror` — a periodic
// readback of earth/sand — so brushes, picking and undo work on the eroded
// terrain rather than the generated one.
//
// Erosion is behind a dev toggle, keep-or-cut undecided (D22). Off → no
// erosion passes run, and anything suspended settles where it is first.

export interface ErosionSettings {
  /** Master switch for passes 4 + 5 (D22). */
  hydraulic: boolean;
  /** Kc — carrying capacity per unit tilt·speed. */
  capacity: number;
  /** Ks — rate sand is lifted toward capacity, 1/s. */
  erodeSand: number;
  /** Ke — rate earth is lifted once a cell's sand is gone, 1/s. */
  erodeEarth: number;
  /** Kd — rate an over-capacity load settles, 1/s. */
  deposit: number;
  /** Floor on sin(tilt), so fast water on the flat still carries a little. */
  minTilt: number;
  /** Water depth at which carrying capacity reaches full strength. */
  fullDepth: number;
}

// First guesses — expected to move a lot once watched on-device. Tuning is
// the milestone (brief §1); these just need to be in the right ballpark to
// see something happen. Velocities here run 0–100 (pipe model units), tilts
// 0–0.7, so Kc ≈ 0.02 gives a fast river on a moderate slope a capacity of
// order 0.1 height units.
export const DEFAULT_EROSION_SETTINGS: ErosionSettings = {
  hydraulic: true,
  capacity: 0.02,
  erodeSand: 0.5,
  erodeEarth: 0.1,
  deposit: 0.5,
  minTilt: 0.02,
  fullDepth: 0.1,
};

export interface ErosionStats {
  /** Σ (earth + sand + suspended) · cellArea — the "loose" material. Rock is excluded: erosion never touches it. */
  looseVolume: number;
  /** Σ suspended · cellArea. */
  suspendedVolume: number;
  /** Total material carried off the map edge since the last reset · cellArea. */
  exportedVolume: number;
  maxSuspended: number;
  /** Largest single-cell bed change in one tick, since the last stats sample. */
  maxTickChange: number;
  /** Smallest earth / sand / suspended value anywhere — all must stay ≥ 0. */
  minEarth: number;
  minSand: number;
  minSuspended: number;
}

export interface ErosionSimOptions {
  fieldCols: number;
  fieldRows: number;
  hexSize: number;
  heightTexture: GPUTexture;
  earthTexture: GPUTexture;
  sandTexture: GPUTexture;
  rock: Float32Array;
  earth: Float32Array;
  sand: Float32Array;
  water: WaterSim;
}

export interface ErosionSim {
  /** Live-tunable; read every tick. */
  settings: ErosionSettings;
  /** Encode this tick's erosion passes after the water passes. No-op while hydraulic is off. */
  encode(encoder: GPUCommandEncoder, dt: number, waterBufs: WaterTickBuffers, timer: GpuTimer): void;
  /** Call straight after the tick's queue.submit(). */
  afterSubmit(): void;
  /** Whether the GPU terrain may have diverged from the CPU copy since the last mirror. */
  isDirty(): boolean;
  /** Copy one brushed rectangle of the CPU arrays into the sim's buffers. */
  uploadRegion(box: BoundingBox, rock: Float32Array, earth: Float32Array, sand: Float32Array): void;
  /** Replace the whole terrain (regeneration) — also clears the suspended load and the exported tally. */
  resetTerrain(rock: Float32Array, earth: Float32Array, sand: Float32Array): void;
  /** Non-blocking readback of earth/sand, for the CPU copy. Callback gets fresh arrays a frame or two later. */
  requestMirror(callback: (earth: Float32Array, sand: Float32Array) => void): void;
  /** Non-blocking conservation readback. Ignored if one is in flight. */
  requestStats(callback: (stats: ErosionStats) => void): void;
}

const WORKGROUP = 8;

export function createErosionSim(gpu: GpuContext, opts: ErosionSimOptions): ErosionSim {
  const { device } = gpu;
  const { fieldCols, fieldRows, hexSize } = opts;
  const cellCount = fieldCols * fieldRows;
  const pipeLength = Math.sqrt(3) * hexSize;
  const cellArea = ((3 * Math.sqrt(3)) / 2) * hexSize * hexSize;

  const settings: ErosionSettings = { ...DEFAULT_EROSION_SETTINGS };

  // --- buffers -----------------------------------------------------------
  const makeStorage = (bytes: number, extraUsage = 0) =>
    device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | extraUsage });

  const rockBuffer = makeStorage(cellCount * 4);
  const earthBuffer = makeStorage(cellCount * 4, GPUBufferUsage.COPY_SRC);
  const sandBuffer = makeStorage(cellCount * 4, GPUBufferUsage.COPY_SRC);
  // Suspended load ping-pongs for advection (brief §4.2), like water does.
  const suspSand: [GPUBuffer, GPUBuffer] = [makeStorage(cellCount * 4), makeStorage(cellCount * 4)];
  const suspEarth: [GPUBuffer, GPUBuffer] = [makeStorage(cellCount * 4), makeStorage(cellCount * 4)];
  // Material carried off the map, per edge cell (D17 perimeter layout).
  const perimeter = edgeSlotCount(fieldCols, fieldRows);
  const exportedBuffer = makeStorage(perimeter * 4, GPUBufferUsage.COPY_SRC);
  const statsAtomicBuffer = makeStorage(16, GPUBufferUsage.COPY_SRC);
  const partialsBuffer = makeStorage(fieldRows * 2 * 16, GPUBufferUsage.COPY_SRC);

  device.queue.writeBuffer(rockBuffer, 0, opts.rock as Float32Array<ArrayBuffer>);
  device.queue.writeBuffer(earthBuffer, 0, opts.earth as Float32Array<ArrayBuffer>);
  device.queue.writeBuffer(sandBuffer, 0, opts.sand as Float32Array<ArrayBuffer>);

  // --- params uniform ------------------------------------------------------
  // Must match `struct Params` in erosion.wgsl: 9 f32, 3 u32 = 48 bytes.
  const paramsBytes = new ArrayBuffer(48);
  const pf = new Float32Array(paramsBytes);
  const pu = new Uint32Array(paramsBytes);
  pf[7] = pipeLength;
  pf[8] = cellArea;
  pu[9] = fieldCols;
  pu[10] = fieldRows;
  const paramsBuffer = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

  function writeParams(dt: number, recordStats: boolean): void {
    pf[0] = dt;
    pf[1] = settings.capacity;
    pf[2] = settings.erodeSand;
    pf[3] = settings.erodeEarth;
    pf[4] = settings.deposit;
    pf[5] = settings.minTilt;
    pf[6] = Math.max(settings.fullDepth, 1e-6);
    pu[11] = recordStats ? 1 : 0;
    device.queue.writeBuffer(paramsBuffer, 0, paramsBytes);
  }

  // --- pipelines -----------------------------------------------------------
  // layout: 'auto' — each entry point binds only what it uses (see the
  // header of erosion.wgsl), so bind groups are built per pipeline.
  const module = device.createShaderModule({ code: hexGridSrc + '\n' + shaderSrc });
  const pipeline = (entryPoint: string) =>
    device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint } });
  const erodePipeline = pipeline('cs_erode');
  const advectPipeline = pipeline('cs_advect');
  const composePipeline = pipeline('cs_compose');
  const dropPipeline = pipeline('cs_drop');
  const reducePipeline = pipeline('cs_reduce');

  const buf = (binding: number, buffer: GPUBuffer): GPUBindGroupEntry => ({ binding, resource: { buffer } });
  const params = buf(0, paramsBuffer);
  const heightView = opts.heightTexture.createView();

  // Suspended parity s (current = suspX[s]) × water tick buffers (after index w).
  const erodeGroups = [0, 1].map((s) =>
    [0, 1].map((w) =>
      device.createBindGroup({
        layout: erodePipeline.getBindGroupLayout(0),
        entries: [
          params,
          { binding: 1, resource: heightView },
          buf(3, earthBuffer),
          buf(4, sandBuffer),
          buf(5, suspSand[s]!),
          buf(6, suspEarth[s]!),
          buf(9, opts.water.waterBuffers[w]!),
          buf(12, opts.water.velocityBuffer),
          buf(14, statsAtomicBuffer),
        ],
      })
    )
  );
  // Suspended parity s (source) × water "before" index w.
  const advectGroups = [0, 1].map((s) =>
    [0, 1].map((w) =>
      device.createBindGroup({
        layout: advectPipeline.getBindGroupLayout(0),
        entries: [
          params,
          buf(5, suspSand[s]!),
          buf(6, suspEarth[s]!),
          buf(7, suspSand[1 - s]!),
          buf(8, suspEarth[1 - s]!),
          buf(10, opts.water.waterBuffers[w]!),
          buf(11, opts.water.fluxBuffer),
          buf(13, exportedBuffer),
        ],
      })
    )
  );
  const composeGroup = device.createBindGroup({
    layout: composePipeline.getBindGroupLayout(0),
    entries: [
      params,
      buf(2, rockBuffer),
      buf(3, earthBuffer),
      buf(4, sandBuffer),
      { binding: 15, resource: opts.heightTexture.createView() },
      { binding: 16, resource: opts.earthTexture.createView() },
      { binding: 17, resource: opts.sandTexture.createView() },
    ],
  });
  const dropGroups = [0, 1].map((s) =>
    device.createBindGroup({
      layout: dropPipeline.getBindGroupLayout(0),
      entries: [params, buf(3, earthBuffer), buf(4, sandBuffer), buf(5, suspSand[s]!), buf(6, suspEarth[s]!)],
    })
  );
  const reduceGroups = [0, 1].map((s) =>
    device.createBindGroup({
      layout: reducePipeline.getBindGroupLayout(0),
      entries: [
        params,
        buf(3, earthBuffer),
        buf(4, sandBuffer),
        buf(5, suspSand[s]!),
        buf(6, suspEarth[s]!),
        buf(18, partialsBuffer),
      ],
    })
  );

  const wgX = Math.ceil(fieldCols / WORKGROUP);
  const wgY = Math.ceil(fieldRows / WORKGROUP);

  let susp: 0 | 1 = 0; // which suspended buffers hold the current load
  let wasHydraulic = settings.hydraulic;
  let dirty = false;

  // --- readbacks ------------------------------------------------------------
  // Stats: per-row partials + the perimeter export tally + the max-change atomic.
  const statsBytes = fieldRows * 2 * 16 + perimeter * 4 + 16;
  const statsReadback = device.createBuffer({ size: statsBytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  let statsState: 'idle' | 'requested' | 'encoded' | 'mapping' = 'idle';
  let statsCallback: ((s: ErosionStats) => void) | null = null;

  // Mirror: earth + sand, back-to-back.
  const mirrorReadback = device.createBuffer({
    size: cellCount * 8,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  let mirrorState: 'idle' | 'requested' | 'mapping' = 'idle';
  let mapMirror = false; // mirror copy encoded this tick; map it once the submit lands
  let mirrorCallback: ((earth: Float32Array, sand: Float32Array) => void) | null = null;

  function encodeCompose(encoder: GPUCommandEncoder, timer: GpuTimer): void {
    const pass = encoder.beginComputePass(timer.pass('compose'));
    pass.setPipeline(composePipeline);
    pass.setBindGroup(0, composeGroup);
    pass.dispatchWorkgroups(wgX, wgY);
    pass.end();
  }

  function encode(encoder: GPUCommandEncoder, dt: number, waterBufs: WaterTickBuffers, timer: GpuTimer): void {
    const hydraulic = settings.hydraulic;
    const collectStats = statsState === 'requested';
    writeParams(dt, collectStats);

    if (hydraulic) {
      if (collectStats) encoder.clearBuffer(statsAtomicBuffer);

      let pass = encoder.beginComputePass(timer.pass('erode'));
      pass.setPipeline(erodePipeline);
      pass.setBindGroup(0, erodeGroups[susp]![waterBufs.after]!);
      pass.dispatchWorkgroups(wgX, wgY);
      pass.end();

      pass = encoder.beginComputePass(timer.pass('advect'));
      pass.setPipeline(advectPipeline);
      pass.setBindGroup(0, advectGroups[susp]![waterBufs.before]!);
      pass.dispatchWorkgroups(wgX, wgY);
      pass.end();
      susp = susp === 0 ? 1 : 0;

      encodeCompose(encoder, timer);
      dirty = true;
    } else if (wasHydraulic) {
      // Just switched off (D22): settle the suspended load in place so the
      // material total is unchanged, then refresh the textures once.
      const pass = encoder.beginComputePass();
      pass.setPipeline(dropPipeline);
      pass.setBindGroup(0, dropGroups[susp]!);
      pass.dispatchWorkgroups(wgX, wgY);
      pass.end();
      encodeCompose(encoder, timer);
      dirty = true;
    }
    wasHydraulic = hydraulic;

    if (collectStats) {
      if (!hydraulic) encoder.clearBuffer(statsAtomicBuffer); // nothing eroded this tick
      const pass = encoder.beginComputePass();
      pass.setPipeline(reducePipeline);
      pass.setBindGroup(0, reduceGroups[susp]!);
      pass.dispatchWorkgroups(fieldRows);
      pass.end();
      let off = 0;
      encoder.copyBufferToBuffer(partialsBuffer, 0, statsReadback, off, fieldRows * 2 * 16);
      off += fieldRows * 2 * 16;
      encoder.copyBufferToBuffer(exportedBuffer, 0, statsReadback, off, perimeter * 4);
      off += perimeter * 4;
      encoder.copyBufferToBuffer(statsAtomicBuffer, 0, statsReadback, off, 16);
      statsState = 'encoded';
    }

    if (mirrorState === 'requested') {
      encoder.copyBufferToBuffer(earthBuffer, 0, mirrorReadback, 0, cellCount * 4);
      encoder.copyBufferToBuffer(sandBuffer, 0, mirrorReadback, cellCount * 4, cellCount * 4);
      mirrorState = 'mapping';
      dirty = false; // the copy captures everything up to this tick
      mapMirror = true;
    }
  }

  function afterSubmit(): void {
    if (statsState === 'encoded') {
      statsState = 'mapping';
      statsReadback
        .mapAsync(GPUMapMode.READ)
        .then(() => {
          const bytes = statsReadback.getMappedRange();
          const rows = new Float32Array(bytes, 0, fieldRows * 8);
          const exp = new Float32Array(bytes, fieldRows * 2 * 16, perimeter);
          const atom = new Uint32Array(bytes, fieldRows * 2 * 16 + perimeter * 4, 4);
          let loose = 0;
          let suspended = 0;
          let maxSusp = 0;
          let minE = Infinity;
          let minS = Infinity;
          let minSusp = Infinity;
          for (let r = 0; r < fieldRows; r++) {
            loose += rows[r * 8]!;
            suspended += rows[r * 8 + 1]!;
            maxSusp = Math.max(maxSusp, rows[r * 8 + 2]!);
            minE = Math.min(minE, rows[r * 8 + 4]!);
            minS = Math.min(minS, rows[r * 8 + 5]!);
            minSusp = Math.min(minSusp, rows[r * 8 + 6]!);
          }
          let exported = 0;
          for (let k = 0; k < perimeter; k++) exported += exp[k]!;
          const maxChange = new Float32Array(new Uint32Array([atom[0]!]).buffer)[0]!;
          statsReadback.unmap();
          statsCallback?.({
            looseVolume: loose * cellArea,
            suspendedVolume: suspended * cellArea,
            exportedVolume: exported * cellArea,
            maxSuspended: maxSusp,
            maxTickChange: maxChange,
            minEarth: minE,
            minSand: minS,
            minSuspended: minSusp,
          });
        })
        .catch(() => {
          /* device lost — drop this sample */
        })
        .finally(() => {
          statsState = 'idle';
        });
    }

    if (mapMirror) {
      mapMirror = false;
      mirrorReadback
        .mapAsync(GPUMapMode.READ)
        .then(() => {
          const all = new Float32Array(mirrorReadback.getMappedRange());
          const earth = all.slice(0, cellCount);
          const sand = all.slice(cellCount);
          mirrorReadback.unmap();
          mirrorCallback?.(earth, sand);
        })
        .catch(() => {
          /* device lost — drop this sample */
        })
        .finally(() => {
          mirrorState = 'idle';
        });
    }
  }

  // Region upload: the CPU arrays are repacked into a compact staging buffer
  // (one writeBuffer per material), then copied row by row into place on the
  // GPU in a single submit. Precise to the rectangle, so erosion elsewhere in
  // those rows isn't overwritten by the CPU's older copy — and one submit
  // rather than hundreds of small writeBuffer calls, which matters in
  // Safari's out-of-process WebGPU.
  let staging: GPUBuffer | null = null;
  let stagingData = new Float32Array(0);

  function uploadRegion(box: BoundingBox, rock: Float32Array, earth: Float32Array, sand: Float32Array): void {
    const w = box.colMax - box.colMin + 1;
    const h = box.rowMax - box.rowMin + 1;
    const n = w * h;
    if (n <= 0) return;
    if (stagingData.length < n * 3) {
      staging?.destroy();
      stagingData = new Float32Array(n * 3);
      staging = device.createBuffer({ size: n * 3 * 4, usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    }
    const sources = [rock, earth, sand];
    for (let m = 0; m < 3; m++) {
      const src = sources[m]!;
      for (let r = 0; r < h; r++) {
        const from = (box.rowMin + r) * fieldCols + box.colMin;
        stagingData.set(src.subarray(from, from + w), m * n + r * w);
      }
    }
    device.queue.writeBuffer(staging!, 0, stagingData as Float32Array<ArrayBuffer>, 0, n * 3);
    const encoder = device.createCommandEncoder();
    const targets = [rockBuffer, earthBuffer, sandBuffer];
    for (let m = 0; m < 3; m++) {
      for (let r = 0; r < h; r++) {
        encoder.copyBufferToBuffer(
          staging!,
          (m * n + r * w) * 4,
          targets[m]!,
          ((box.rowMin + r) * fieldCols + box.colMin) * 4,
          w * 4
        );
      }
    }
    device.queue.submit([encoder.finish()]);
  }

  function resetTerrain(rock: Float32Array, earth: Float32Array, sand: Float32Array): void {
    device.queue.writeBuffer(rockBuffer, 0, rock as Float32Array<ArrayBuffer>);
    device.queue.writeBuffer(earthBuffer, 0, earth as Float32Array<ArrayBuffer>);
    device.queue.writeBuffer(sandBuffer, 0, sand as Float32Array<ArrayBuffer>);
    const encoder = device.createCommandEncoder();
    for (const b of [...suspSand, ...suspEarth, exportedBuffer]) encoder.clearBuffer(b);
    device.queue.submit([encoder.finish()]);
    susp = 0;
    dirty = false;
  }

  return {
    settings,
    encode,
    afterSubmit,
    isDirty: () => dirty,
    uploadRegion,
    resetTerrain,
    requestMirror(callback) {
      if (mirrorState !== 'idle') return;
      mirrorState = 'requested';
      mirrorCallback = callback;
    },
    requestStats(callback) {
      if (statsState !== 'idle') return;
      statsState = 'requested';
      statsCallback = callback;
    },
  };
}
