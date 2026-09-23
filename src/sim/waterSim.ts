import shaderSrc from './water.wgsl?raw';
import type { GpuContext } from '../render/webgpu';
import { buildEdgeGhostHeights, edgeSlotCount } from './edgeGhost';

// M3 water simulation — virtual-pipes model on the hex grid. Owns the water
// field on the GPU from creation onward (see docs/design/05-m3-brief.md §4.1:
// terrain stays CPU-authoritative, water becomes GPU-authoritative).

export interface WaterSimOptions {
  fieldCols: number;
  fieldRows: number;
  /** Hex centre-to-corner radius, world units — sets pipe length and cell area. */
  hexSize: number;
  /** The terrain surface height texture (r32float). Read-only here; M3 does no erosion. */
  heightTexture: GPUTexture;
  /** Initial standing-water depth per cell (from the generator's flood fill). */
  initialWater: Float32Array;
  /** Generation-time terrain surface height, snapshotted at the edges as the world beyond the map (D17). */
  initialSurfaceHeight: Float32Array;
  /** Surface of the off-map sea (D17) — the generator's waterLevel. Edges whose frozen ground is above it are dry land. */
  seaLevel: number;
  /**
   * Hardcoded test water sources for M3 (brief §2 — real spring placement is
   * a player tool designed after the sim is proven). Up to 8. `ratePerSecond`
   * defaults to `SPRING_RATE`. Omit entirely to get a single spring at the
   * field centre.
   */
  springs?: { col: number; row: number; ratePerSecond?: number }[];
}

export interface WaterSimStats {
  /** Σ depth · cellArea over the whole field. Tracks rain in − evaporation out ± flow through the map edge (D17). */
  totalVolume: number;
  maxDepth: number;
  /** Smallest per-cell depth seen. The clamp should keep this ≥ 0; a negative value means the pipe model is over-draining somewhere. */
  minDepth: number;
}

export interface WaterSim {
  /** One fixed-timestep tick: input → flux (+ clamp) → water (+ evaporation + velocity). One submit. */
  step(dt: number): void;
  /** Which ping-pong buffer holds the current state, for the renderer to bind. */
  currentWaterIndex(): 0 | 1;
  waterBufferA: GPUBuffer;
  waterBufferB: GPUBuffer;
  /**
   * Re-seed the water field after terrain regeneration and clear flux/velocity.
   * Also re-freezes the world beyond the edge from the new terrain (D17).
   */
  resetWater(data: Float32Array, surfaceHeight: Float32Array, seaLevel: number): void;
  setRain(enabled: boolean, ratePerSecond?: number): void;
  setEvaporation(ratePerSecond: number): void;
  /** Non-blocking volume/max-depth readback; the callback fires a frame or two later. No-op if one is already in flight. */
  requestStats(callback: (stats: WaterSimStats) => void): void;
}

const WORKGROUP = 8;

// Tuning knobs — all provisional for the M3 first slice, expected to change
// once it's watched on-device. The clamp in the shader keeps the sim stable
// across a wide range of these regardless.
const GRAVITY = 9.81;
const DEFAULT_RAIN_RATE = 0.03; // depth/sec added everywhere
const DEFAULT_EVAP_RATE = 0.012; // fraction of depth/sec
const SPRING_RATE = 3.0; // depth/sec injected at the single hardcoded test spring

// Master "how fast does water accelerate downhill" knob. Nominally the
// virtual pipe's cross-sectional area (geometrically ~hexSize²), but that
// value flows like syrup on gentle slopes — the flux takes a second-plus of
// sim time to spin up. This multiplies it. Raise for faster/looser flow;
// lower it (or add flux damping) if water starts sloshing back and forth.
const FLOW_STRENGTH = 8;

// Per-tick multiplier on accumulated flux, applied ONLY to pipes pushing
// against the surface gradient (dh <= 0). Intended to bleed slosh momentum
// overshooting equilibrium. 1.0 = no damping (original Mei et al.); lower =
// firmer. At 30 Hz, 0.98 retains ~55% of that residual flux per second,
// 0.95 ~21%, 0.9 ~4%.
//
// DISABLED (1.0) 2026-09-02: at 0.9 it also killed the micro-gradient that
// pushes water *through* a chain of connected near-flat pools (dh ≈ 0
// everywhere, so flux just decays by this factor each tick), stalling flow
// to distant reservoirs. Net-negative as implemented. If sloshing comes
// back, address it via FLOW_STRENGTH or a depth-aware scheme, not a blanket
// gradient-sign multiplier. Feeds D15.
const FLUX_DAMPING = 1.0;

export function createWaterSim(gpu: GpuContext, opts: WaterSimOptions): WaterSim {
  const { device } = gpu;
  const { fieldCols, fieldRows, hexSize, heightTexture, initialWater, initialSurfaceHeight } = opts;
  const cellCount = fieldCols * fieldRows;

  if (opts.springs && opts.springs.length > 8) {
    throw new Error(`waterSim: at most 8 springs, got ${opts.springs.length}`);
  }

  const pipeLength = Math.sqrt(3) * hexSize;
  const cellArea = ((3 * Math.sqrt(3)) / 2) * hexSize * hexSize;
  const pipeArea = hexSize * hexSize * FLOW_STRENGTH;

  // --- buffers ---------------------------------------------------------------
  const makeStorage = (elems: number, extraUsage = 0) =>
    device.createBuffer({
      size: elems * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | extraUsage,
    });

  // COPY_SRC on the water buffers so the stats readback can copy one out.
  const waterBufferA = makeStorage(cellCount, GPUBufferUsage.COPY_SRC);
  const waterBufferB = makeStorage(cellCount, GPUBufferUsage.COPY_SRC);
  const fluxBuffer = makeStorage(cellCount * 6);
  const velocityBuffer = makeStorage(cellCount * 2);
  const waterBuffers: [GPUBuffer, GPUBuffer] = [waterBufferA, waterBufferB];
  const ghostBuffer = makeStorage(edgeSlotCount(fieldCols, fieldRows));
  device.queue.writeBuffer(
    ghostBuffer,
    0,
    buildEdgeGhostHeights(initialSurfaceHeight, fieldCols, fieldRows) as Float32Array<ArrayBuffer>
  );

  device.queue.writeBuffer(waterBufferA, 0, initialWater as Float32Array<ArrayBuffer>);
  // waterBufferB, flux, velocity start zeroed per the WebGPU spec.

  // --- params uniform ------------------------------------------------------
  // Layout must match `struct Params` in water.wgsl exactly (192 bytes):
  //   f32 dt, rainRate, rainEnabled, evapRate,
  //   f32 gravity, pipeArea, pipeLength, cellArea,
  //   u32 fieldCols, fieldRows, springCount; f32 fluxDamping,
  //   vec4<f32> springs[8]   (col, row, ratePerSec, _)
  //   f32 seaLevel           (+ 12 bytes padding to the struct's 16-byte alignment)
  const PARAMS_SIZE = 192;
  const paramsBytes = new ArrayBuffer(PARAMS_SIZE);
  const pf = new Float32Array(paramsBytes);
  const pu = new Uint32Array(paramsBytes);
  pf[4] = GRAVITY;
  pf[5] = pipeArea;
  pf[6] = pipeLength;
  pf[7] = cellArea;
  pu[8] = fieldCols;
  pu[9] = fieldRows;
  pf[11] = FLUX_DAMPING;
  pf[44] = opts.seaLevel;

  let rainEnabled = true;
  let rainRate = DEFAULT_RAIN_RATE;
  let evapRate = DEFAULT_EVAP_RATE;

  // Hardcoded test springs. Real spring placement is a player tool designed
  // after the sim is proven (brief §2). Default: one at the field centre;
  // the damming demo overrides this with a spring at a known channel head.
  const springs: { col: number; row: number; rate: number }[] = (
    opts.springs ?? [{ col: fieldCols >> 1, row: fieldRows >> 1 }]
  ).map((s) => ({ col: s.col, row: s.row, rate: s.ratePerSecond ?? SPRING_RATE }));
  pu[10] = springs.length;
  springs.forEach((s, k) => {
    pf[12 + k * 4 + 0] = s.col;
    pf[12 + k * 4 + 1] = s.row;
    pf[12 + k * 4 + 2] = s.rate;
  });

  const paramsBuffer = device.createBuffer({
    size: PARAMS_SIZE,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  // --- pipelines ---------------------------------------------------------
  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
    ],
  });

  const module = device.createShaderModule({ code: shaderSrc });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });
  const inputPipeline = device.createComputePipeline({ layout, compute: { module, entryPoint: 'cs_input' } });
  const fluxPipeline = device.createComputePipeline({ layout, compute: { module, entryPoint: 'cs_flux' } });
  const waterPipeline = device.createComputePipeline({ layout, compute: { module, entryPoint: 'cs_water' } });

  const heightView = heightTexture.createView();
  function bindGroup(src: GPUBuffer, dst: GPUBuffer): GPUBindGroup {
    return device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: paramsBuffer } },
        { binding: 1, resource: heightView },
        { binding: 2, resource: { buffer: src } },
        { binding: 3, resource: { buffer: dst } },
        { binding: 4, resource: { buffer: fluxBuffer } },
        { binding: 5, resource: { buffer: velocityBuffer } },
        { binding: 6, resource: { buffer: ghostBuffer } },
      ],
    });
  }
  // parity 0: src=A dst=B ; parity 1: src=B dst=A
  const bindGroups: [GPUBindGroup, GPUBindGroup] = [
    bindGroup(waterBufferA, waterBufferB),
    bindGroup(waterBufferB, waterBufferA),
  ];

  const wgX = Math.ceil(fieldCols / WORKGROUP);
  const wgY = Math.ceil(fieldRows / WORKGROUP);

  let parity: 0 | 1 = 0;
  let currentIndex: 0 | 1 = 0; // buffer holding the latest written state

  // --- stats readback ---------------------------------------------------
  const readback = device.createBuffer({
    size: cellCount * 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  let readbackBusy = false; // a stats request is somewhere between asked-for and delivered
  let pendingCopy = false; // copy into `readback` still needs encoding on the next step
  let mapAfterSubmit = false; // copy encoded this step; map it once the submit lands
  let statsCallback: ((s: WaterSimStats) => void) | null = null;

  function writeParams(dt: number): void {
    pf[0] = dt;
    pf[1] = rainRate;
    pf[2] = rainEnabled ? 1 : 0;
    pf[3] = evapRate;
    device.queue.writeBuffer(paramsBuffer, 0, paramsBytes);
  }

  function step(dt: number): void {
    writeParams(dt);

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setBindGroup(0, bindGroups[parity]);
    pass.setPipeline(inputPipeline);
    pass.dispatchWorkgroups(wgX, wgY);
    pass.setPipeline(fluxPipeline);
    pass.dispatchWorkgroups(wgX, wgY);
    pass.setPipeline(waterPipeline);
    pass.dispatchWorkgroups(wgX, wgY);
    pass.end();

    const dstIndex: 0 | 1 = parity === 0 ? 1 : 0;

    if (pendingCopy) {
      encoder.copyBufferToBuffer(waterBuffers[dstIndex], 0, readback, 0, cellCount * 4);
      pendingCopy = false;
      mapAfterSubmit = true;
    }

    device.queue.submit([encoder.finish()]);

    currentIndex = dstIndex;
    parity = parity === 0 ? 1 : 0;

    if (mapAfterSubmit) {
      mapAfterSubmit = false;
      readback
        .mapAsync(GPUMapMode.READ)
        .then(() => {
          const arr = new Float32Array(readback.getMappedRange());
          let sum = 0;
          let mx = 0;
          let mn = Infinity;
          for (let k = 0; k < arr.length; k++) {
            const v = arr[k]!;
            sum += v;
            if (v > mx) mx = v;
            if (v < mn) mn = v;
          }
          readback.unmap();
          statsCallback?.({ totalVolume: sum * cellArea, maxDepth: mx, minDepth: mn === Infinity ? 0 : mn });
        })
        .catch(() => {
          /* device lost or buffer destroyed — drop this sample */
        })
        .finally(() => {
          readbackBusy = false;
        });
    }
  }

  function requestStats(callback: (s: WaterSimStats) => void): void {
    if (readbackBusy) return;
    readbackBusy = true;
    pendingCopy = true;
    statsCallback = callback;
  }

  function resetWater(data: Float32Array, surfaceHeight: Float32Array, seaLevel: number): void {
    device.queue.writeBuffer(waterBufferA, 0, data as Float32Array<ArrayBuffer>);
    device.queue.writeBuffer(
      ghostBuffer,
      0,
      buildEdgeGhostHeights(surfaceHeight, fieldCols, fieldRows) as Float32Array<ArrayBuffer>
    );
    pf[44] = seaLevel; // uploaded with the next step's writeParams
    const encoder = device.createCommandEncoder();
    encoder.clearBuffer(waterBufferB);
    encoder.clearBuffer(fluxBuffer);
    encoder.clearBuffer(velocityBuffer);
    device.queue.submit([encoder.finish()]);
    parity = 0;
    currentIndex = 0;
  }

  return {
    step,
    currentWaterIndex: () => currentIndex,
    waterBufferA,
    waterBufferB,
    resetWater,
    setRain(enabled, ratePerSecond) {
      rainEnabled = enabled;
      if (ratePerSecond !== undefined) rainRate = ratePerSecond;
    },
    setEvaporation(ratePerSecond) {
      evapRate = ratePerSecond;
    },
    requestStats,
  };
}
