import { DiagnosticsOverlay } from './diagnostics/overlay';
import { initDeviceConsole } from './diagnostics/console';
import { initWebGPU, describeAdapter, WebGPUUnsupportedError } from './render/webgpu';
import { buildHexMesh } from './render/mesh';
import { createTerrainPipeline } from './render/terrainPipeline';
import { createWaterPipeline } from './render/waterPipeline';
import { createFrameRenderer } from './render/frame';
import { generateTerrain, type TerrainGenParams } from './terrain/generator';
import { OrbitCamera } from './camera/orbitCamera';
import { createControlPanel } from './ui/controls';

const FIELD_SIZE = 1024;
const MESH_SIZE = 512;
const HEX_SIZE = 2; // world units (metres) per hex, centre-to-corner

const TERRAIN_PARAMS: TerrainGenParams = {
  width: FIELD_SIZE,
  height: FIELD_SIZE,
  seed: 1,
  ruggedness: 0.5,
  depthRange: 60,
  elevationRange: 60,
  wavelength: 180,
  worldStepX: HEX_SIZE * Math.sqrt(3),
  worldStepZ: HEX_SIZE * 1.5,
  waterLevel: -10,
  rockiness: 0.4,
  maxSoilDepth: 6,
  sandBand: 15,
};

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

  function generateAndPack(params: TerrainGenParams) {
    const terrainData = generateTerrain(params);
    const surfaceHeight = new Float32Array(FIELD_SIZE * FIELD_SIZE);
    for (let i = 0; i < surfaceHeight.length; i++) {
      surfaceHeight[i] = terrainData.rock[i]! + terrainData.earth[i]! + terrainData.sand[i]!;
    }
    return { terrainData, surfaceHeight };
  }

  const { terrainData, surfaceHeight } = generateAndPack(TERRAIN_PARAMS);

  const mesh = buildHexMesh({
    meshCols: MESH_SIZE,
    meshRows: MESH_SIZE,
    fieldCols: FIELD_SIZE,
    fieldRows: FIELD_SIZE,
    hexSize: HEX_SIZE,
  });

  const terrain = createTerrainPipeline(
    gpu,
    mesh,
    surfaceHeight,
    terrainData.earth,
    terrainData.sand,
    TERRAIN_PARAMS.maxSoilDepth,
    FIELD_SIZE,
    FIELD_SIZE
  );
  const water = createWaterPipeline(
    gpu,
    mesh,
    terrain.vertexBuffer,
    terrain.indexBuffer,
    terrain.heightTexture,
    terrainData.water,
    FIELD_SIZE,
    FIELD_SIZE
  );
  const frame = createFrameRenderer(gpu);

  createControlPanel(TERRAIN_PARAMS, (newParams) => {
    const generated = generateAndPack(newParams);
    terrain.updateTerrainData(generated.surfaceHeight, generated.terrainData.earth, generated.terrainData.sand, newParams.maxSoilDepth);
    water.updateWaterData(generated.terrainData.water);
  });

  const worldWidth = FIELD_SIZE * HEX_SIZE * Math.sqrt(3);
  const camera = new OrbitCamera(canvas, {
    minDistance: HEX_SIZE * 5,
    maxDistance: worldWidth * 1.5,
    initialDistance: worldWidth * 0.4,
    target: [worldWidth / 2, 0, (FIELD_SIZE * HEX_SIZE * 1.5) / 2],
  });

  const lightDir: [number, number, number] = [0.4, 0.8, 0.3];

  function tick() {
    const aspect = gpu!.canvas.width / gpu!.canvas.height;
    const viewProj = camera.viewProjection(aspect);
    terrain.updateUniforms(viewProj, lightDir);
    water.updateUniforms(viewProj);

    frame.render({ r: 0.6, g: 0.75, b: 0.9, a: 1 }, (pass) => {
      terrain.draw(pass);
      water.draw(pass);
    });

    diagnostics.recordFrame();
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

main().catch((err) => diagnostics.showFatal(`Unhandled startup error: ${err}`));
