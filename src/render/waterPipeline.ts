import shaderSrc from './water.wgsl?raw';
import type { HexMesh } from './mesh';
import type { GpuContext } from './webgpu';

export interface WaterPipeline {
  updateUniforms(viewProj: Float32Array): void;
  /** Point the render at whichever of the sim's two ping-pong buffers holds the current state. */
  setWaterBufferIndex(index: 0 | 1): void;
  draw(pass: GPURenderPassEncoder): void;
}

// Shares the terrain's vertex/index buffers and height texture — same mesh
// topology, just a different surface height and a translucent shader. The
// water depth comes from the M3 sim's storage buffers (double-buffered), so
// this holds a bind group for each and switches per tick.
export function createWaterPipeline(
  gpu: GpuContext,
  mesh: HexMesh,
  vertexBuffer: GPUBuffer,
  indexBuffer: GPUBuffer,
  heightTexture: GPUTexture,
  waterBufferA: GPUBuffer,
  waterBufferB: GPUBuffer,
  fieldCols: number,
  _fieldRows: number
): WaterPipeline {
  const { device, format } = gpu;

  // mat4x4 viewProj (64) + fieldCols u32 padded to 16 (16) = 80.
  const uniformBuffer = device.createBuffer({
    size: 80,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, texture: { sampleType: 'unfilterable-float' } },
      { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
    ],
  });

  function bindGroupFor(waterBuffer: GPUBuffer): GPUBindGroup {
    return device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: heightTexture.createView() },
        { binding: 2, resource: { buffer: waterBuffer } },
      ],
    });
  }

  const bindGroups: [GPUBindGroup, GPUBindGroup] = [bindGroupFor(waterBufferA), bindGroupFor(waterBufferB)];
  let activeIndex: 0 | 1 = 0;

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

  const uniformData = new Float32Array(20);
  new Uint32Array(uniformData.buffer)[16] = fieldCols; // never changes

  function updateUniforms(viewProj: Float32Array): void {
    uniformData.set(viewProj, 0);
    device.queue.writeBuffer(uniformBuffer, 0, uniformData);
  }

  function setWaterBufferIndex(index: 0 | 1): void {
    activeIndex = index;
  }

  function draw(pass: GPURenderPassEncoder): void {
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroups[activeIndex]);
    pass.setVertexBuffer(0, vertexBuffer);
    pass.setIndexBuffer(indexBuffer, 'uint32');
    pass.drawIndexed(mesh.indices.length);
  }

  return { updateUniforms, setWaterBufferIndex, draw };
}
