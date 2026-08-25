import shaderSrc from './cursor.wgsl?raw';
import type { GpuContext } from './webgpu';

export const CURSOR_RING_SEGMENTS = 48;

export interface CursorPipeline {
  /** points: flat [x,y,z, x,y,z, ...] world-space ring vertices — CURSOR_RING_SEGMENTS + 1 of them (closed loop). */
  update(viewProj: Float32Array, points: Float32Array): void;
  draw(pass: GPURenderPassEncoder): void;
}

const VERTEX_COUNT = CURSOR_RING_SEGMENTS + 1;

export function createCursorPipeline(gpu: GpuContext): CursorPipeline {
  const { device, format } = gpu;

  const vertexBuffer = device.createBuffer({
    size: VERTEX_COUNT * 3 * 4,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });

  const uniformBuffer = device.createBuffer({
    size: 64, // mat4x4 viewProj only
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const bindGroupLayout = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }],
  });
  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
  });

  const shaderModule = device.createShaderModule({ code: shaderSrc });
  const pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
    vertex: {
      module: shaderModule,
      entryPoint: 'vs_main',
      buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }],
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
    primitive: { topology: 'line-strip' },
    depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less' },
  });

  function update(viewProj: Float32Array, points: Float32Array): void {
    device.queue.writeBuffer(uniformBuffer, 0, viewProj as Float32Array<ArrayBuffer>);
    device.queue.writeBuffer(vertexBuffer, 0, points as Float32Array<ArrayBuffer>);
  }

  function draw(pass: GPURenderPassEncoder): void {
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.setVertexBuffer(0, vertexBuffer);
    pass.draw(VERTEX_COUNT);
  }

  return { update, draw };
}
