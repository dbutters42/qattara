import shaderSrc from './terrain.wgsl?raw';
import type { HexMesh } from './mesh';
import type { GpuContext } from './webgpu';

export interface TerrainPipeline {
  heightTexture: GPUTexture;
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  updateUniforms(viewProj: Float32Array, lightDir: [number, number, number]): void;
  /** Re-uploads generated data in place — no pipeline/texture recreation, matching "editing the world is a texture write". */
  updateTerrainData(heightData: Float32Array, earthData: Float32Array, sandData: Float32Array, maxSoilDepth: number): void;
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
  fieldRows: number
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

  function uploadR32Float(data: Float32Array): GPUTexture {
    const texture = device.createTexture({
      size: { width: fieldCols, height: fieldRows },
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    writeR32Float(texture, data);
    return texture;
  }

  const heightTexture = uploadR32Float(heightData);
  const earthTexture = uploadR32Float(earthData);
  const sandTexture = uploadR32Float(sandData);

  const uniformBuffer = device.createBuffer({
    size: 96, // mat4x4 viewProj (64) + lightDir vec4 (16) + worldStep/maxSoilDepth vec4 (16)
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  // unfilterable-float on all three: we only ever textureLoad (exact texel
  // fetch), never sample — sidesteps the float32-filterable optional-feature
  // question entirely.
  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
    ],
  });

  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: uniformBuffer } },
      { binding: 1, resource: heightTexture.createView() },
      { binding: 2, resource: earthTexture.createView() },
      { binding: 3, resource: sandTexture.createView() },
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
  // (16-19), worldStep.xy + maxSoilDepth in .z (20-23).
  const uniformData = new Float32Array(24);
  uniformData[20] = mesh.worldStepX;
  uniformData[21] = mesh.worldStepZ;
  uniformData[22] = maxSoilDepth;

  function updateUniforms(viewProj: Float32Array, lightDir: [number, number, number]): void {
    uniformData.set(viewProj, 0);
    uniformData[16] = lightDir[0];
    uniformData[17] = lightDir[1];
    uniformData[18] = lightDir[2];
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

  function draw(pass: GPURenderPassEncoder): void {
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.setVertexBuffer(0, vertexBuffer);
    pass.setIndexBuffer(indexBuffer, 'uint32');
    pass.drawIndexed(mesh.indices.length);
  }

  return { heightTexture, vertexBuffer, indexBuffer, updateUniforms, updateTerrainData, draw };
}
