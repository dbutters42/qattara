import { DiagnosticsOverlay } from './diagnostics/overlay';
import { initDeviceConsole } from './diagnostics/console';
import { initWebGPU, describeAdapter, WebGPUUnsupportedError } from './render/webgpu';
import { buildHexMesh } from './render/mesh';
import { createTerrainPipeline } from './render/terrainPipeline';
import { generateHeightField } from './terrain/heightfield';
import { OrbitCamera } from './camera/orbitCamera';

// M0 world parameters. Field/mesh sizing follows docs/design/03-outline.md
// 3.4/4: a 1024x1024 height field, displayed through a coarser 512x512
// vertex mesh. Terrain-generation parameters here are placeholders — M1
// replaces this with the real generator, built around Dane's inputs.
const FIELD_SIZE = 1024;
const MESH_SIZE = 512;
const HEX_SIZE = 2; // world units (metres) per hex, centre-to-corner
const HEIGHT_AMPLITUDE = 60;
const HEIGHT_WAVELENGTH = 180;

// Diagnostics come up before anything else. On iPad there is no Web
// Inspector without a Mac, so this overlay — not a debugger — is how a
// failure gets seen at all.
const diagnostics = new DiagnosticsOverlay();

initDeviceConsole().catch((err) => diagnostics.logError(`eruda failed to load: ${err}`));

async function main() {
  const canvas = document.getElementById('gpu-canvas') as HTMLCanvasElement;

  let gpu;
  try {
    gpu = await initWebGPU(canvas);
  } catch (err) {
    if (err instanceof WebGPUUnsupportedError) {
      diagnostics.showFatal(err.message);
    } else {
      diagnostics.showFatal(`WebGPU init failed unexpectedly: ${err}`);
    }
    return;
  }

  diagnostics.setDeviceInfo(describeAdapter(gpu.adapter, gpu.device));

  // WebGPU validation/runtime errors surface here, not via window.onerror —
  // without this, a failing pipeline or bind group fails silently on screen.
  gpu.device.addEventListener('uncapturederror', (e) => {
    diagnostics.logError(`WebGPU: ${(e as GPUUncapturedErrorEvent).error.message}`);
  });

  const heightData = generateHeightField({
    width: FIELD_SIZE,
    height: FIELD_SIZE,
    amplitude: HEIGHT_AMPLITUDE,
    wavelength: HEIGHT_WAVELENGTH,
  });

  const mesh = buildHexMesh({
    meshCols: MESH_SIZE,
    meshRows: MESH_SIZE,
    fieldCols: FIELD_SIZE,
    fieldRows: FIELD_SIZE,
    hexSize: HEX_SIZE,
  });

  const terrain = createTerrainPipeline(gpu, mesh, heightData, FIELD_SIZE, FIELD_SIZE);

  const worldWidth = FIELD_SIZE * HEX_SIZE * Math.sqrt(3);
  const camera = new OrbitCamera(canvas, {
    minDistance: HEX_SIZE * 5,
    maxDistance: worldWidth * 1.5,
    initialDistance: worldWidth * 0.4,
    target: [worldWidth / 2, 0, (FIELD_SIZE * HEX_SIZE * 1.5) / 2],
  });

  const lightDir: [number, number, number] = [0.4, 0.8, 0.3];

  function frame() {
    const aspect = gpu!.canvas.width / gpu!.canvas.height;
    terrain.render(camera.viewProjection(aspect), lightDir);
    diagnostics.recordFrame();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

main().catch((err) => diagnostics.showFatal(`Unhandled startup error: ${err}`));
