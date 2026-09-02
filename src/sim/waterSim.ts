import shaderSrc from './water.wgsl?raw';
import type { GpuContext } from '../render/webgpu';

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
}

export interface WaterSimStats {
  /** Σ depth · cellArea over the whole field. Should track (rain in − evaporation out). */
  totalVolume: number;
  maxDepth: number;
}

export interface WaterSim {
  /** One fixed-timestep tick: input → flux (+ clamp) → water (+ evaporation + velocity). One submit. */
  step(dt: number): void;
  /** Which ping-pong buffer holds the current state, for the renderer to bind. */
  currentWaterIndex(): 0 | 1;
  waterBufferA: GPUBuffer;
  waterBufferB: GPUBuffer;
  /** Re-seed the water field (e.g. after terrain regeneration) and clear flux/velocity. */
  resetWater(data: Float32Array): void;
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

export function createWaterSim(gpu: GpuContext, opts: WaterSimOptions): WaterSim {
  const { device } = gpu;
  const { fieldCols, fieldRows, hexSize, heightTexture, initialWater } = opts;
  const cellCount = fieldCols * fieldRows;

  const pipeLength = Math.sqrt(3) * hexSize;
  const cellArea = ((3 * Math.sqrt(3)) / 2) * hexSize * hexSize;
  const pipeArea = hexSize * hexSize;

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

  device.queue.writeBuffer(waterBufferA, 0, initialWater as Float32Array<ArrayBuffer>);
  // waterBufferB, flux, velocity start zeroed per the WebGPU spec.

  // --- params uniform ------------------------------------------------------
  // Layout must match `struct Params` in water.wgsl exactly (176 bytes):
  //   f32 dt, rainRate, rainEnabled, evapRate,
  //   f32 gravity, pipeArea, pipeLength, cellArea,
  //   u32 fieldCols, fieldRows, springCount, _pad,
  //   vec4<f32> springs[8]   (col, row, ratePerSec, _)
  const paramsBytes = new ArrayBuffer(176);
  const pf = new Float32Array(paramsBytes);
  const pu = new Uint32Array(paramsBytes);
  pf[4] = GRAVITY;
  pf[5] = pipeArea;
  pf[6] = pipeLength;
  pf[7] = cellArea;
  pu[8] = fieldCols;
  pu[9] = fieldRows;

  let rainEnabled = true;
  let rainRate = DEFAULT_RAIN_RATE;
  let evapRate = DEFAULT_EVAP_RATE;

  // One hardcoded test spring at the field centre. Real spring placement is a
  // player tool designed after the sim is proven (brief §2).
  const springs: { col: number; row: number; rate: number }[] = [
    { col: fieldCols >> 1, row: fieldRows >> 1, rate: SPRING_RATE },
  ];
  pu[10] = springs.length;
  springs.forEach((s, k) => {
    pf[12 + k * 4 + 0] = s.col;
    pf[12 + k * 4 + 1] = s.row;
    pf[12 + k * 4 + 2] = s.rate;
  });

  const paramsBuffer = device.createBuffer({
    size: 176,
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
          for (let k = 0; k < arr.length; k++) {
            const v = arr[k]!;
            sum += v;
            if (v > mx) mx = v;
          }
          readback.unmap();
          statsCallback?.({ totalVolume: sum * cellArea, maxDepth: mx });
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

  function resetWater(data: Float32Array): void {
    device.queue.writeBuffer(waterBufferA, 0, data as Float32Array<ArrayBuffer>);
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
