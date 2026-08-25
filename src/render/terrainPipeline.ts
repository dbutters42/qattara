import shaderSrc from './terrain.wgsl?raw';
import type { HexMesh } from './mesh';
import type { GpuContext } from './webgpu';

export interface TerrainPipeline {
  render(viewProj: Float32Array, lightDir: [number, number, number]): void;
}

export function createTerrainPipeline(
  gpu: GpuContext,
  mesh: HexMesh,
  heightData: Float32Array,
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

  const heightTexture = device.createTexture({
    size: { width: fieldCols, height: fieldRows },
    format: 'r32float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture: heightTexture },
    heightData as Float32Array<ArrayBuffer>,
    { bytesPerRow: fieldCols * 4, rowsPerImage: fieldRows },
    { width: fieldCols, height: fieldRows }
  );

  const uniformBuffer = device.createBuffer({
    size: 96, // mat4x4 viewProj (64) + lightDir vec4 (16) + worldStep vec4 (16)
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      // unfilterable-float: we only ever textureLoad (exact texel fetch), never sample —
      // sidesteps the float32-filterable optional-feature question entirely.
      { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
    ],
  });

  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: uniformBuffer } },
      { binding: 1, resource: heightTexture.createView() },
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

  let depthTexture = createDepthTexture(device, gpu.canvas.width, gpu.canvas.height);

  // Layout must match the WGSL struct exactly: viewProj (0-15), lightDir (16-19), worldStep (20-23).
  const uniformData = new Float32Array(24);
  uniformData[20] = mesh.worldStepX;
  uniformData[21] = mesh.worldStepZ;

  function render(viewProj: Float32Array, lightDir: [number, number, number]): void {
    if (depthTexture.width !== gpu.canvas.width || depthTexture.height !== gpu.canvas.height) {
      depthTexture.destroy();
      depthTexture = createDepthTexture(device, gpu.canvas.width, gpu.canvas.height);
    }

    uniformData.set(viewProj, 0);
    uniformData[16] = lightDir[0];
    uniformData[17] = lightDir[1];
    uniformData[18] = lightDir[2];
    device.queue.writeBuffer(uniformBuffer, 0, uniformData);

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: gpu.context.getCurrentTexture().createView(),
          clearValue: { r: 0.6, g: 0.75, b: 0.9, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: depthTexture.createView(),
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.setVertexBuffer(0, vertexBuffer);
    pass.setIndexBuffer(indexBuffer, 'uint32');
    pass.drawIndexed(mesh.indices.length);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  return { render };
}

function createDepthTexture(device: GPUDevice, width: number, height: number): GPUTexture {
  return device.createTexture({
    size: { width, height },
    format: 'depth24plus',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
}
