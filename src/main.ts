import { DiagnosticsOverlay } from './diagnostics/overlay';
import { initDeviceConsole } from './diagnostics/console';
import { initWebGPU, describeAdapter, WebGPUUnsupportedError } from './render/webgpu';
import { buildHexMesh } from './render/mesh';
import { createTerrainPipeline } from './render/terrainPipeline';
import { createWaterPipeline } from './render/waterPipeline';
import { createFrameRenderer } from './render/frame';
import { createCursorPipeline, CURSOR_RING_SEGMENTS } from './render/cursorPipeline';
import { sampleHeightField } from './terrain/sample';
import { generateTerrain, type TerrainGenParams } from './terrain/generator';
import { OrbitCamera } from './camera/orbitCamera';
import { createControlPanel } from './ui/controls';
import { createToolbar } from './ui/toolbar';
import { pickTerrain } from './interaction/picking';
import { applyBrush, type ToolId, type MaterialArrays } from './interaction/brush';
import { createUndoStack } from './interaction/undoStack';
import { createWaterSim } from './sim/waterSim';

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

  const initial = generateAndPack(TERRAIN_PARAMS);
  let currentSurfaceHeight = initial.surfaceHeight;
  let currentTerrainData: MaterialArrays = initial.terrainData;
  const { terrainData, surfaceHeight } = initial;

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
  // M3: water is now a GPU compute simulation, seeded once from the
  // generator's flood-fill and GPU-authoritative from here (brief §4.1).
  const sim = createWaterSim(gpu, {
    fieldCols: FIELD_SIZE,
    fieldRows: FIELD_SIZE,
    hexSize: HEX_SIZE,
    heightTexture: terrain.heightTexture,
    initialWater: terrainData.water,
  });
  const water = createWaterPipeline(
    gpu,
    mesh,
    terrain.vertexBuffer,
    terrain.indexBuffer,
    terrain.heightTexture,
    sim.waterBufferA,
    sim.waterBufferB,
    FIELD_SIZE,
    FIELD_SIZE
  );
  const frame = createFrameRenderer(gpu);
  const cursor = createCursorPipeline(gpu);

  const undoStack = createUndoStack(5); // "a few actions" — brush strokes only, see undoStack.ts

  createControlPanel(TERRAIN_PARAMS, (newParams) => {
    const generated = generateAndPack(newParams);
    currentSurfaceHeight = generated.surfaceHeight;
    currentTerrainData = generated.terrainData;
    terrain.updateTerrainData(generated.surfaceHeight, generated.terrainData.earth, generated.terrainData.sand, newParams.maxSoilDepth);
    sim.resetWater(generated.terrainData.water); // new terrain, restart the sim's water field from its flood fill
    undoStack.clear(); // old snapshots belong to a terrain that no longer exists
    toolbar.setUndoEnabled(false);
  });

  const worldWidth = FIELD_SIZE * HEX_SIZE * Math.sqrt(3);
  const camera = new OrbitCamera(canvas, {
    minDistance: HEX_SIZE * 5,
    maxDistance: worldWidth * 1.5,
    initialDistance: worldWidth * 0.4,
    target: [worldWidth / 2, 0, (FIELD_SIZE * HEX_SIZE * 1.5) / 2],
  });

  // Brush editing (M2). Touch picking was validated as tap-to-log earlier
  // in this milestone; this replaces that with real painting.
  const maxPickDistance = worldWidth * 3;

  let activeTool: ToolId | null = null;
  let cursorPoint: { x: number; y: number; z: number } | null = null;
  let levelReference: number | null = null; // Level tool: set at stroke start, cleared at stroke end — a single continuous gesture
  let fillToLevelReference: number | null = null; // Fill to Level: set by a sampling tap, persists across separate strokes until the tool is deselected
  let touchedCellsThisStroke: Set<number> | null = null;
  const toolbar = createToolbar(
    (tool) => {
      if (activeTool === 'fillToLevel' && tool !== 'fillToLevel') {
        fillToLevelReference = null; // leaving the tool primes it to sample fresh next time
      }
      activeTool = tool;
      camera.setPanEnabled(tool === null);
      if (!tool) cursorPoint = null;
    },
    () => {
      const snapshot = undoStack.undo();
      if (!snapshot) return;
      currentTerrainData = snapshot;
      for (let i = 0; i < currentSurfaceHeight.length; i++) {
        currentSurfaceHeight[i] = snapshot.rock[i]! + snapshot.earth[i]! + snapshot.sand[i]!;
      }
      terrain.updateTerrainData(currentSurfaceHeight, snapshot.earth, snapshot.sand, TERRAIN_PARAMS.maxSoilDepth);
      // Water is sim-owned now (brief §4.1). It keeps flowing over whatever
      // terrain exists and reads the height texture live, so the reverted
      // terrain simply takes effect on the next tick — undo doesn't touch it.
      toolbar.setUndoEnabled(undoStack.canUndo());
    }
  );

  function screenToRay(e: PointerEvent) {
    const rect = canvas.getBoundingClientRect();
    const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
    const aspect = gpu!.canvas.width / gpu!.canvas.height;
    return camera.pickRay(ndcX, ndcY, aspect);
  }

  function paintAt(e: PointerEvent): void {
    if (!activeTool) return;
    const ray = screenToRay(e);
    const hit = pickTerrain(ray, currentSurfaceHeight, FIELD_SIZE, FIELD_SIZE, HEX_SIZE, maxPickDistance);
    if (!hit) {
      cursorPoint = null;
      return;
    }
    cursorPoint = { x: hit.point[0], y: hit.point[1], z: hit.point[2] };

    // Level: a single continuous gesture — first touch of the stroke sets
    // the reference. Fill to Level's reference is handled separately, in
    // the pointerdown handler below, since it's sampled by its own discrete
    // tap rather than the start of the applying stroke.
    if (activeTool === 'level' && levelReference === null) {
      levelReference = hit.point[1];
    }

    const box = applyBrush(
      activeTool,
      hit.q,
      hit.r,
      currentTerrainData,
      FIELD_SIZE,
      FIELD_SIZE,
      HEX_SIZE,
      TERRAIN_PARAMS.worldStepX,
      TERRAIN_PARAMS.worldStepZ,
      {
        radius: toolbar.settings.size,
        strength: toolbar.settings.intensity,
        steepness: toolbar.settings.steepness,
        material: toolbar.getActiveMaterial(),
        levelReference: (activeTool === 'fillToLevel' ? fillToLevelReference : levelReference) ?? undefined,
        touchedCellsThisStroke: touchedCellsThisStroke ?? undefined,
      }
    );

    for (let row = box.rowMin; row <= box.rowMax; row++) {
      for (let col = box.colMin; col <= box.colMax; col++) {
        const idx = row * FIELD_SIZE + col;
        currentSurfaceHeight[idx] =
          currentTerrainData.rock[idx]! + currentTerrainData.earth[idx]! + currentTerrainData.sand[idx]!;
      }
    }
    terrain.updateTerrainRegion(box, currentSurfaceHeight, currentTerrainData.earth, currentTerrainData.sand);
    // Water isn't re-flooded on brush edits yet — there's no simulation
    // driving it until M3, so a freshly-raised dam wouldn't hold anything
    // back yet regardless. Revisit once M3 lands.
  }

  let isPainting = false;
  canvas.addEventListener('pointerdown', (e) => {
    if (!activeTool || !e.isPrimary) return;
    isPainting = true;

    // Fill to Level's reference is set by its own discrete tap — doesn't
    // paint anything, so no undo snapshot or touched-cells tracking either.
    // Any touch after this one (a separate stroke, possibly somewhere
    // entirely different on the map) applies using the sampled reference.
    if (activeTool === 'fillToLevel' && fillToLevelReference === null) {
      const ray = screenToRay(e);
      const hit = pickTerrain(ray, currentSurfaceHeight, FIELD_SIZE, FIELD_SIZE, HEX_SIZE, maxPickDistance);
      if (hit) {
        fillToLevelReference = hit.point[1];
        cursorPoint = { x: hit.point[0], y: hit.point[1], z: hit.point[2] };
      }
      return;
    }

    touchedCellsThisStroke = new Set();
    undoStack.push({
      rock: currentTerrainData.rock.slice(),
      earth: currentTerrainData.earth.slice(),
      sand: currentTerrainData.sand.slice(),
    });
    toolbar.setUndoEnabled(true);
    paintAt(e);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (isPainting && e.isPrimary) paintAt(e);
  });
  const stopPainting = () => {
    isPainting = false;
    cursorPoint = null;
    levelReference = null; // next stroke establishes its own fresh reference
    touchedCellsThisStroke = null;
  };
  canvas.addEventListener('pointerup', stopPainting);
  canvas.addEventListener('pointercancel', stopPainting);

  const lightDir: [number, number, number] = [0.4, 0.8, 0.3];

  // One height sample per ring vertex, computed here on the CPU (reusing the
  // same lookup picking already uses) so the ring actually hugs the terrain
  // it's about to paint — rather than sitting flat at a fixed height and
  // getting depth-occluded behind ridges, which looked like the brush was
  // skipping hidden terrain when it was really just the indicator lying.
  const cursorRingPoints = new Float32Array((CURSOR_RING_SEGMENTS + 1) * 3);
  function updateCursorRingPoints(centerX: number, centerY: number, centerZ: number, radius: number): void {
    for (let i = 0; i <= CURSOR_RING_SEGMENTS; i++) {
      const a = (i / CURSOR_RING_SEGMENTS) * Math.PI * 2;
      const x = centerX + Math.cos(a) * radius;
      const z = centerZ + Math.sin(a) * radius;
      const h = sampleHeightField(x, z, currentSurfaceHeight, FIELD_SIZE, FIELD_SIZE, HEX_SIZE) ?? centerY;
      cursorRingPoints[i * 3] = x;
      cursorRingPoints[i * 3 + 1] = h + 0.5; // small lift to reduce z-fighting with the terrain surface
      cursorRingPoints[i * 3 + 2] = z;
    }
  }

  // The water sim runs on a fixed 30 Hz clock, decoupled from the render
  // frame rate (outline §3 / brief §4.6). Accumulate real elapsed time, spend
  // it in whole ticks, and cap the catch-up so a backgrounded tab coming back
  // doesn't trigger a huge stall.
  const SIM_TICK_HZ = 30;
  const SIM_TICK_DT = 1 / SIM_TICK_HZ;
  const MAX_STEPS_PER_FRAME = 5;
  let simAccumulator = 0;
  let lastSimClock = performance.now();
  let ticksSinceStatsRequest = 0;
  let ticksThisSecond = 0;
  let ticksPerSecond = 0;
  let statsSecondClock = performance.now();
  let lastVolume = 0;
  let lastMaxDepth = 0;

  function stepSim(): void {
    const now = performance.now();
    simAccumulator += Math.min((now - lastSimClock) / 1000, 0.25);
    lastSimClock = now;

    let steps = 0;
    while (simAccumulator >= SIM_TICK_DT && steps < MAX_STEPS_PER_FRAME) {
      sim.step(SIM_TICK_DT);
      simAccumulator -= SIM_TICK_DT;
      steps++;
      ticksSinceStatsRequest++;
      ticksThisSecond++;
    }
    if (steps === MAX_STEPS_PER_FRAME) simAccumulator = 0; // maxed out — shed the backlog, let sim time slip

    if (steps > 0) water.setWaterBufferIndex(sim.currentWaterIndex());

    if (now - statsSecondClock >= 1000) {
      ticksPerSecond = ticksThisSecond;
      ticksThisSecond = 0;
      statsSecondClock = now;
    }
    if (ticksSinceStatsRequest >= 30) {
      ticksSinceStatsRequest = 0;
      sim.requestStats((s) => {
        lastVolume = s.totalVolume;
        lastMaxDepth = s.maxDepth;
      });
    }
    diagnostics.setSimStats(
      `water: vol ${lastVolume.toFixed(0)} | max depth ${lastMaxDepth.toFixed(2)} | ${ticksPerSecond}/s`
    );
  }

  function tick() {
    stepSim();

    const aspect = gpu!.canvas.width / gpu!.canvas.height;
    const viewProj = camera.viewProjection(aspect);
    terrain.updateUniforms(viewProj, lightDir);
    water.updateUniforms(viewProj);

    if (cursorPoint) {
      updateCursorRingPoints(cursorPoint.x, cursorPoint.y, cursorPoint.z, toolbar.settings.size);
      cursor.update(viewProj, cursorRingPoints);
    }

    frame.render({ r: 0.6, g: 0.75, b: 0.9, a: 1 }, (pass) => {
      terrain.draw(pass);
      water.draw(pass);
      if (cursorPoint) cursor.draw(pass);
    });

    diagnostics.recordFrame();
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

main().catch((err) => diagnostics.showFatal(`Unhandled startup error: ${err}`));
