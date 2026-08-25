import type { GpuContext } from './webgpu';

export interface FrameRenderer {
  /** Runs one render pass shared by all drawables — same depth buffer, single submit. */
  render(clearColor: GPUColorDict, draw: (pass: GPURenderPassEncoder) => void): void;
}

export function createFrameRenderer(gpu: GpuContext): FrameRenderer {
  const { device } = gpu;
  let depthTexture = createDepthTexture(device, gpu.canvas.width, gpu.canvas.height);

  function render(clearColor: GPUColorDict, draw: (pass: GPURenderPassEncoder) => void): void {
    if (depthTexture.width !== gpu.canvas.width || depthTexture.height !== gpu.canvas.height) {
      depthTexture.destroy();
      depthTexture = createDepthTexture(device, gpu.canvas.width, gpu.canvas.height);
    }

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: gpu.context.getCurrentTexture().createView(),
          clearValue: clearColor,
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
    draw(pass);
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
