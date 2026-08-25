export class WebGPUUnsupportedError extends Error {}

export interface GpuContext {
  adapter: GPUAdapter;
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
  canvas: HTMLCanvasElement;
}

// Cap the backing-store resolution below the raw devicePixelRatio. iPhones at
// 3x retina would otherwise ask the GPU to fill ~3x the pixels for no visible
// gain on a terrain view — the M0 frame-rate targets assume this cap.
const MAX_DEVICE_PIXEL_RATIO = 2;

export async function initWebGPU(canvas: HTMLCanvasElement): Promise<GpuContext> {
  if (!navigator.gpu) {
    throw new WebGPUUnsupportedError(
      'WebGPU is not available in this browser. On iPad/iPhone this needs ' +
        'Safari on iOS/iPadOS 26 or later. On desktop, a recent Chrome or Edge.'
    );
  }

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    throw new WebGPUUnsupportedError(
      'navigator.gpu.requestAdapter() returned null — WebGPU is present but no ' +
        'compatible GPU adapter was found on this device.'
    );
  }

  const device = await adapter.requestDevice();
  device.lost.then((info) => {
    throw new Error(`WebGPU device lost: ${info.reason} — ${info.message}`);
  });

  const context = canvas.getContext('webgpu');
  if (!context) {
    throw new WebGPUUnsupportedError('canvas.getContext("webgpu") returned null.');
  }

  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });

  fitCanvasToContainer(canvas, context, device, format);
  new ResizeObserver(() => fitCanvasToContainer(canvas, context, device, format)).observe(canvas);

  return { adapter, device, context, format, canvas };
}

function fitCanvasToContainer(
  canvas: HTMLCanvasElement,
  context: GPUCanvasContext,
  device: GPUDevice,
  format: GPUTextureFormat
): void {
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO);
  const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width === width && canvas.height === height) return;
  canvas.width = width;
  canvas.height = height;
  context.configure({ device, format, alphaMode: 'opaque' });
}

export function describeAdapter(adapter: GPUAdapter, device: GPUDevice): string[] {
  const info = adapter.info;
  const lines: string[] = [];
  if (info) {
    lines.push(`adapter: ${info.vendor || '?'} / ${info.architecture || '?'} / ${info.device || '?'}`);
  }
  lines.push(
    `maxTextureDimension2D: ${device.limits.maxTextureDimension2D}`,
    `maxBufferSize: ${device.limits.maxBufferSize}`
  );
  return lines;
}
