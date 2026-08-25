import shaderSrc from './water.wgsl?raw';
import type { HexMesh } from './mesh';
import type { GpuContext } from './webgpu';

export interface WaterPipeline {
  updateUniforms(viewProj: Float32Array): void;
  updateWaterData(waterData: Float32Array): void;
  draw(pass: GPURenderPassEncoder): void;
}

// Shares the terrain's vertex/index buffers and height texture — same mesh
// topology, just a different surface height and a translucent shader.
export function createWaterPipeline(
  gpu: GpuContext,
  mesh: HexMesh,
  vertexBuffer: GPUBuffer,
  indexBuffer: GPUBuffer,
  heightTexture: GPUTexture,
  waterData: Float32Array,
  fieldCols: number,
  fieldRows: number
): WaterPipeline {
  const { device, format } = gpu;

  const waterTexture = device.createTexture({
    size: { width: fieldCols, height: fieldRows },
    format: 'r32float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture: waterTexture },
    waterData as Float32Array<ArrayBuffer>,
    { bytesPerRow: fieldCols * 4, rowsPerImage: fieldRows },
    { width: fieldCols, height: fieldRows }
  );

  const uniformBuffer = device.createBuffer({
    size: 64, // mat4x4 viewProj only — water doesn't need lighting/worldStep
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, texture: { sampleType: 'unfilterable-float' } },
      { binding: 2, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
    ],
  });

  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: uniformBuffer } },
      { binding: 1, resource: heightTexture.createView() },
      { binding: 2, resource: waterTexture.createView() },
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
      targets: [
        {
          format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        },
      ],
    },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: {
      format: 'depth24plus',
      depthWriteEnabled: false, // translucent — test against terrain depth, don't occlude other water fragments
      depthCompare: 'less',
    },
  });

  const uniformData = new Float32Array(16);

  function updateUniforms(viewProj: Float32Array): void {
    uniformData.set(viewProj, 0);
    device.queue.writeBuffer(uniformBuffer, 0, uniformData);
  }

  function updateWaterData(newWaterData: Float32Array): void {
    device.queue.writeTexture(
      { texture: waterTexture },
      newWaterData as Float32Array<ArrayBuffer>,
      { bytesPerRow: fieldCols * 4, rowsPerImage: fieldRows },
      { width: fieldCols, height: fieldRows }
    );
  }

  function draw(pass: GPURenderPassEncoder): void {
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.setVertexBuffer(0, vertexBuffer);
    pass.setIndexBuffer(indexBuffer, 'uint32');
    pass.drawIndexed(mesh.indices.length);
  }

  return { updateUniforms, updateWaterData, draw };
}
