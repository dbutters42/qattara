import shaderSrc from './terrain.wgsl?raw';
import type { HexMesh } from './mesh';
import type { GpuContext } from './webgpu';
import type { BoundingBox } from '../interaction/brush';
import { buildReliefLUT, type ReliefTheme } from './reliefTheme';

const RELIEF_LUT_WIDTH = 512;

export interface TerrainPipeline {
  /** Also writable as a storage texture: since M4 the erosion sim rewrites all three each tick it runs. */
  heightTexture: GPUTexture;
  earthTexture: GPUTexture;
  sandTexture: GPUTexture;
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  /** `seaLevel` is the current generator water level — the hinge of the hypsometric ramp. */
  updateUniforms(viewProj: Float32Array, lightDir: [number, number, number], seaLevel: number): void;
  /** Re-uploads generated data in place — no pipeline/texture recreation, matching "editing the world is a texture write". */
  updateTerrainData(heightData: Float32Array, earthData: Float32Array, sandData: Float32Array, maxSoilDepth: number): void;
  /** Re-uploads just a sub-rectangle — brush edits touch a small area many times a second; a full-field write would be wasteful. */
  updateTerrainRegion(box: BoundingBox, heightData: Float32Array, earthData: Float32Array, sandData: Float32Array): void;
  /** Swap the hypsometric palette at runtime — rebakes the LUT and updates the span/mix uniforms. The hook for a future theme picker. */
  setReliefTheme(theme: ReliefTheme): void;
  draw(pass: GPURenderPassEncoder): void;
}

export function createTerrainPipeline(
  gpu: GpuContext,
  mesh: HexMesh,
  heightData: Float32Array,
  earthData: Float32Array,
  sandData: Float32Array,
  maxSoilDepth: number,
  fieldCols: number,
  fieldRows: number,
  reliefTheme: ReliefTheme
): TerrainPipeline {
  const { device, format } = gpu;

  const vertexBuffer = device.createBuffer({
    size: mesh.vertices.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(vertexBuffer, 0, mesh.vertices as Float32Array<ArrayBuffer>);

  const indexBuffer = device.createBuffer({
    size: mesh.indices.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(indexBuffer, 0, mesh.indices as Uint32Array<ArrayBuffer>);

  function writeR32Float(texture: GPUTexture, data: Float32Array): void {
    device.queue.writeTexture(
      { texture },
      data as Float32Array<ArrayBuffer>,
      { bytesPerRow: fieldCols * 4, rowsPerImage: fieldRows },
      { width: fieldCols, height: fieldRows }
    );
  }

  function writeR32FloatRegion(texture: GPUTexture, data: Float32Array, box: BoundingBox): void {
    const w = box.colMax - box.colMin + 1;
    const h = box.rowMax - box.rowMin + 1;
    // `offset`/`bytesPerRow` describe the *source* layout, which can be (and
    // here is) larger than the copied region — no need to repack a
    // sub-rectangle into its own compact buffer first.
    device.queue.writeTexture(
      { texture, origin: { x: box.colMin, y: box.rowMin } },
      data as Float32Array<ArrayBuffer>,
      { offset: (box.rowMin * fieldCols + box.colMin) * 4, bytesPerRow: fieldCols * 4, rowsPerImage: fieldRows },
      { width: w, height: h }
    );
  }

  function uploadR32Float(data: Float32Array): GPUTexture {
    const texture = device.createTexture({
      size: { width: fieldCols, height: fieldRows },
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.STORAGE_BINDING,
    });
    writeR32Float(texture, data);
    return texture;
  }

  const heightTexture = uploadR32Float(heightData);
  const earthTexture = uploadR32Float(earthData);
  const sandTexture = uploadR32Float(sandData);

  // 1-D hypsometric colour LUT (src/render/reliefTheme.ts). rgba8unorm so it's
  // a normal filterable/loadable texture — no float32 feature question — but
  // the shader only textureLoad()s exact texels, no interpolation.
  const reliefLutTexture = device.createTexture({
    size: { width: RELIEF_LUT_WIDTH, height: 1 },
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  function writeReliefLut(theme: ReliefTheme): void {
    device.queue.writeTexture(
      { texture: reliefLutTexture },
      buildReliefLUT(theme, RELIEF_LUT_WIDTH) as Uint8Array<ArrayBuffer>,
      { bytesPerRow: RELIEF_LUT_WIDTH * 4, rowsPerImage: 1 },
      { width: RELIEF_LUT_WIDTH, height: 1 }
    );
  }
  writeReliefLut(reliefTheme);

  const uniformBuffer = device.createBuffer({
    size: 112, // viewProj (64) + lightDir vec4 (16) + worldStep vec4 (16) + relief vec4 (16)
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  // unfilterable-float on the three heightfield textures: we only ever
  // textureLoad (exact texel fetch), never sample — sidesteps the
  // float32-filterable optional-feature question. The relief LUT is rgba8.
  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    ],
  });

  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: uniformBuffer } },
      { binding: 1, resource: heightTexture.createView() },
      { binding: 2, resource: earthTexture.createView() },
      { binding: 3, resource: sandTexture.createView() },
      { binding: 4, resource: reliefLutTexture.createView() },
    ],
  });

  const shaderModule = device.createShaderModule({ code: shaderSrc });

  const pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
    vertex: {
      module: shaderModule,
      entryPoint: 'vs_main',
      buffers: [
        {
          arrayStride: 16,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' },
            { shaderLocation: 1, offset: 8, format: 'float32x2' },
          ],
        },
      ],
    },
    fragment: {
      module: shaderModule,
      entryPoint: 'fs_main',
      targets: [{ format }],
    },
    primitive: {
      topology: 'triangle-list',
      // Revisit once winding is verified on-device — correctness first, cull later.
      cullMode: 'none',
    },
    depthStencil: {
      format: 'depth24plus',
      depthWriteEnabled: true,
      depthCompare: 'less',
    },
  });

  // Layout must match the WGSL struct exactly: viewProj (0-15), lightDir
  // (16-19), worldStep.xy + maxSoilDepth in .z (20-23), relief vec4 (24-27):
  // seaLevel, belowSpan, aboveSpan, materialMix.
  const uniformData = new Float32Array(28);
  uniformData[20] = mesh.worldStepX;
  uniformData[21] = mesh.worldStepZ;
  uniformData[22] = maxSoilDepth;
  uniformData[25] = reliefTheme.belowSpan;
  uniformData[26] = reliefTheme.aboveSpan;
  uniformData[27] = reliefTheme.materialMix;

  function updateUniforms(viewProj: Float32Array, lightDir: [number, number, number], seaLevel: number): void {
    uniformData.set(viewProj, 0);
    uniformData[16] = lightDir[0];
    uniformData[17] = lightDir[1];
    uniformData[18] = lightDir[2];
    uniformData[24] = seaLevel;
    device.queue.writeBuffer(uniformBuffer, 0, uniformData);
  }

  function setReliefTheme(theme: ReliefTheme): void {
    writeReliefLut(theme);
    uniformData[25] = theme.belowSpan;
    uniformData[26] = theme.aboveSpan;
    uniformData[27] = theme.materialMix;
    device.queue.writeBuffer(uniformBuffer, 0, uniformData);
  }

  function updateTerrainData(
    newHeightData: Float32Array,
    newEarthData: Float32Array,
    newSandData: Float32Array,
    newMaxSoilDepth: number
  ): void {
    writeR32Float(heightTexture, newHeightData);
    writeR32Float(earthTexture, newEarthData);
    writeR32Float(sandTexture, newSandData);
    uniformData[22] = newMaxSoilDepth;
  }

  function updateTerrainRegion(
    box: BoundingBox,
    newHeightData: Float32Array,
    newEarthData: Float32Array,
    newSandData: Float32Array
  ): void {
    writeR32FloatRegion(heightTexture, newHeightData, box);
    writeR32FloatRegion(earthTexture, newEarthData, box);
    writeR32FloatRegion(sandTexture, newSandData, box);
  }

  function draw(pass: GPURenderPassEncoder): void {
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.setVertexBuffer(0, vertexBuffer);
    pass.setIndexBuffer(indexBuffer, 'uint32');
    pass.drawIndexed(mesh.indices.length);
  }

  return { heightTexture, earthTexture, sandTexture, vertexBuffer, indexBuffer, updateUniforms, updateTerrainData, updateTerrainRegion, setReliefTheme, draw };
}
