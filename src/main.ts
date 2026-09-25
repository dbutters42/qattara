import { DiagnosticsOverlay } from './diagnostics/overlay';
import { initDeviceConsole } from './diagnostics/console';
import { initWebGPU, describeAdapter, WebGPUUnsupportedError } from './render/webgpu';
import { buildHexMesh } from './render/mesh';
import { createTerrainPipeline } from './render/terrainPipeline';
import { CLASSIC_ATLAS } from './render/reliefTheme';
import { createWaterPipeline } from './render/waterPipeline';
import { createFrameRenderer } from './render/frame';
import { createCursorPipeline, CURSOR_RING_SEGMENTS } from './render/cursorPipeline';
import { sampleHeightField } from './terrain/sample';
import { generateTerrain, type TerrainGenParams } from './terrain/generator';
import { OrbitCamera } from './camera/orbitCamera';
import { createControlPanel } from './ui/controls';
import { createToolbar } from './ui/toolbar';
import { pickTerrain } from './interaction/picking';
import { applyBrush, type ToolId, type MaterialArrays, type BoundingBox } from './interaction/brush';
import { createUndoStack } from './interaction/undoStack';
import { createWaterSim } from './sim/waterSim';
import { createErosionSim } from './sim/erosionSim';
import { createGpuTimer } from './diagnostics/gpuTimer';
import { createDevPanel } from './ui/devPanel';

const FIELD_SIZE = 1024;
const MESH_SIZE = 512;
const HEX_SIZE = 2; // world units (metres) per hex, centre-to-corner

// The app's normal boot terrain.
const DEFAULT_TERRAIN_PARAMS: TerrainGenParams = {
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

// Repeatable M3 damming-demo scenario (docs/design/05-m3-brief.md §3.1),
// opt-in via `?demo=dam` on the URL — NOT the default, because this terrain
// is deliberately more rugged than the app should boot into. Seed 24's map
// has a well-walled dry channel; the test spring below sits near its head.
// The point is that "raise a ridge across a flowing channel, watch the water
// back up" (brief §3, the headline criterion) is the *same* every run rather
// than depending on where the generated map happens to have a valley. The
// higher ruggedness / wider height ranges are what make the channel hold
// water with a single brush stroke — the default terrain won't.
const DAMMING_DEMO_PARAMS: Partial<TerrainGenParams> = {
  seed: 24,
  ruggedness: 0.75,
  depthRange: 75,
  elevationRange: 85,
};

// A point on the demo channel for seed 24 where it's well walled on both
// sides (floor h~9, walls ~5 up at 4 and 8 cells out) — a few cells below
// the actual channel head, whose far side is open. From here the channel
// runs roughly east (+col), dropping to h~-10 at the natural dam point near
// (row 163, col 195) and on to h~-46 past it. Drag a Raise ridge across the
// channel around the dam point and the water pools behind it. 300 depth/s is
// a watchable fill pace (verified stable on-device up to 1000). Demo runs
// with rain AND evaporation off (below) — with evaporation on, a growing
// wetted channel hits an evaporation-vs-throughflow equilibrium and the
// front stalls partway; see D15.
const DAMMING_DEMO_SPRING = { col: 181, row: 168, ratePerSecond: 300 } as const;

// Sea level below any possible terrain: every map edge is dry land (D17).
const NO_SEA = -1e30;

const URL_PARAMS = new URLSearchParams(location.search);
const DEMO_DAMMING = URL_PARAMS.get('demo') === 'dam';

// Debug overrides for the M3 §3 conservation / stability check — there's no
// player rain/evaporation UI yet (brief §2). `?rain=on|off` / `?evap=on|off`
// force the sim's inputs after setup so the closed-domain volume behaviour
// can be watched on the default map:
//   ?rain=off&evap=off  → total volume dead flat
//   ?rain=on&evap=off   → total volume grows linearly, nothing goes negative
// Applied on top of whatever the scenario set (so `?demo=dam&rain=on` works).
const RAIN_OVERRIDE = URL_PARAMS.get('rain'); // 'on' | 'off' | null
const EVAP_OVERRIDE = URL_PARAMS.get('evap'); // 'on' | 'off' | null
const TERRAIN_PARAMS: TerrainGenParams = DEMO_DAMMING
  ? { ...DEFAULT_TERRAIN_PARAMS, ...DAMMING_DEMO_PARAMS }
  : { ...DEFAULT_TERRAIN_PARAMS };

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

  diagnostics.setDeviceInfo([
    `scenario: ${DEMO_DAMMING ? 'DAM DEMO (?demo=dam)' : 'default'} — seed ${TERRAIN_PARAMS.seed}, rug ${TERRAIN_PARAMS.ruggedness}`,
    ...describeAdapter(gpu.adapter, gpu.device),
  ]);

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
  let currentSeaLevel = TERRAIN_PARAMS.waterLevel; // hinge of the hypsometric relief tint; tracks the water-level slider
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
    FIELD_SIZE,
    CLASSIC_ATLAS
  );
  // M3: water is now a GPU compute simulation, seeded once from the
  // generator's flood-fill and GPU-authoritative from here (brief §4.1).
  // The damming demo starts from a bone-dry world (no flood-fill lake) so the
  // spring is the only water source and the channel reads clearly.
  const sim = createWaterSim(gpu, {
    fieldCols: FIELD_SIZE,
    fieldRows: FIELD_SIZE,
    hexSize: HEX_SIZE,
    heightTexture: terrain.heightTexture,
    initialWater: DEMO_DAMMING ? new Float32Array(FIELD_SIZE * FIELD_SIZE) : terrainData.water,
    initialSurfaceHeight: surfaceHeight,
    // The damming demo has no off-map sea either — the spring must stay the
    // only inflow — so every edge is dry land (water can still drain off).
    seaLevel: DEMO_DAMMING ? NO_SEA : TERRAIN_PARAMS.waterLevel,
    springs: DEMO_DAMMING ? [DAMMING_DEMO_SPRING] : undefined,
  });
  // Global rain (on by default in the sim) swamps the whole map and hides the
  // channel — the damming demo wants the spring to be the only inflow.
  // Evaporation off too: with it on, a growing wetted channel loses more and
  // more water per tick until evaporation balances the (clamp-throttled)
  // throughflow reaching the front, and the front stops advancing partway —
  // looks like the water "won't fill the channel". Off, it pools and rises
  // until it surmounts obstacles, which is the behaviour the demo is showing.
  if (DEMO_DAMMING) {
    sim.setRain(false);
    sim.setEvaporation(0);
  }
  // Debug overrides (see URL_PARAMS above) win over the scenario defaults.
  if (RAIN_OVERRIDE === 'on') sim.setRain(true);
  if (RAIN_OVERRIDE === 'off') sim.setRain(false);
  if (EVAP_OVERRIDE === 'on') sim.setEvaporation(0.012);
  if (EVAP_OVERRIDE === 'off') sim.setEvaporation(0);
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

  // M4: the erosion sim takes ownership of the terrain on the GPU (brief
  // §4.1). From here the CPU arrays are the *brush's* working copy — edits
  // are uploaded by region, and the CPU copy is refreshed from the GPU
  // periodically (see stepSim) so strokes land on the eroded terrain.
  const erosion = createErosionSim(gpu, {
    fieldCols: FIELD_SIZE,
    fieldRows: FIELD_SIZE,
    hexSize: HEX_SIZE,
    heightTexture: terrain.heightTexture,
    earthTexture: terrain.earthTexture,
    sandTexture: terrain.sandTexture,
    rock: terrainData.rock,
    earth: terrainData.earth,
    sand: terrainData.sand,
    water: sim,
  });
  const gpuTimer = createGpuTimer(gpu.device);

  // Bumped by anything that changes the terrain from the CPU side (brush,
  // undo, regenerate). A GPU readback that was in flight across one of these
  // is stale and gets dropped.
  let terrainEditSerial = 0;

  let simSpeed = 1; // dev fast-forward (brief §1): sim ticks per real tick
  createDevPanel(erosion.settings, sim.isRaining(), {
    onSpeed: (speed) => {
      simSpeed = speed;
    },
    onRain: (enabled) => sim.setRain(enabled),
  });

  // Brush strokes only, see undoStack.ts. Each entry remembers the region
  // its stroke touched: undo restores just that rectangle, so it doesn't
  // also roll back erosion that happened elsewhere on the map since.
  type StrokeSnapshot = MaterialArrays & { box: BoundingBox | null };
  const undoStack = createUndoStack<StrokeSnapshot>(5); // "a few actions"
  let strokeSnapshot: StrokeSnapshot | null = null;

  createControlPanel(TERRAIN_PARAMS, (newParams) => {
    const generated = generateAndPack(newParams);
    currentSurfaceHeight = generated.surfaceHeight;
    currentTerrainData = generated.terrainData;
    currentSeaLevel = newParams.waterLevel;
    terrain.updateTerrainData(generated.surfaceHeight, generated.terrainData.earth, generated.terrainData.sand, newParams.maxSoilDepth);
    erosion.resetTerrain(generated.terrainData.rock, generated.terrainData.earth, generated.terrainData.sand);
    terrainEditSerial++;
    // New terrain: restart the water from its flood fill and re-freeze the world beyond the edge (D17).
    sim.resetWater(generated.terrainData.water, generated.surfaceHeight, DEMO_DAMMING ? NO_SEA : newParams.waterLevel);
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
      toolbar.setUndoEnabled(undoStack.canUndo());
      if (!snapshot?.box) return;
      // Restore only the stroke's rectangle (see StrokeSnapshot above).
      const box = snapshot.box;
      const cur = currentTerrainData;
      for (let row = box.rowMin; row <= box.rowMax; row++) {
        const from = row * FIELD_SIZE + box.colMin;
        const to = row * FIELD_SIZE + box.colMax + 1;
        cur.rock.set(snapshot.rock.subarray(from, to), from);
        cur.earth.set(snapshot.earth.subarray(from, to), from);
        cur.sand.set(snapshot.sand.subarray(from, to), from);
        for (let idx = from; idx < to; idx++) {
          currentSurfaceHeight[idx] = cur.rock[idx]! + cur.earth[idx]! + cur.sand[idx]!;
        }
      }
      terrain.updateTerrainRegion(box, currentSurfaceHeight, cur.earth, cur.sand);
      erosion.uploadRegion(box, cur.rock, cur.earth, cur.sand);
      terrainEditSerial++;
      // Water is sim-owned (M3 brief §4.1). It keeps flowing over whatever
      // terrain exists and reads the height texture live, so the reverted
      // terrain simply takes effect on the next tick — undo doesn't touch it.
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
    // The texture write above is what the renderer and the water sim read,
    // so the edit shows (and diverts the flow) on the next tick. The upload
    // below puts it in the erosion sim's buffers too — they own the terrain
    // now (M4 brief §4.1) and would otherwise overwrite the edit on their
    // next compose.
    erosion.uploadRegion(box, currentTerrainData.rock, currentTerrainData.earth, currentTerrainData.sand);
    terrainEditSerial++;
    if (strokeSnapshot) strokeSnapshot.box = unionBox(strokeSnapshot.box, box);
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
    strokeSnapshot = {
      rock: currentTerrainData.rock.slice(),
      earth: currentTerrainData.earth.slice(),
      sand: currentTerrainData.sand.slice(),
      box: null,
    };
    undoStack.push(strokeSnapshot);
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
    strokeSnapshot = null;
  };
  canvas.addEventListener('pointerup', stopPainting);
  canvas.addEventListener('pointercancel', stopPainting);

  // Raking light (altitude ~40°) — a near-overhead sun barely varies the
  // diffuse term across slopes, so relief reads flat. Low light casts the
  // tonal gradients that make terrain legible. Pairs with the hypsometric
  // tint; a future theme may want to own this too.
  const lightDir: [number, number, number] = [0.5, 0.62, 0.35];

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

  // The sim runs on a fixed 30 Hz clock, decoupled from the render frame
  // rate (outline §3 / M3 brief §4.6). Accumulate real elapsed time, spend it
  // in whole ticks, and cap the catch-up so a backgrounded tab coming back
  // doesn't trigger a huge stall. The dev fast-forward multiplies the time
  // fed in: more ticks per frame, each the same size — so a fast-forwarded
  // run behaves exactly like a real-time one, just sooner (M4 brief §1).
  const SIM_TICK_HZ = 30;
  const SIM_TICK_DT = 1 / SIM_TICK_HZ;
  // Catch-up cap: only about one tick per frame beyond what the chosen
  // speed needs at 60 fps. A generous cap (it was 5 × speed) turns one slow
  // frame into a death spiral — the backlog makes the next frame slower
  // still, which grows the backlog. Found on-device 2026-09-25: 8× fell to
  // single-digit fps and 4× lagged under the brush. With this cap, a GPU that
  // can't keep up runs the sim slower than asked instead of dropping frames;
  // the HUD's "actual ×" shows what's really being achieved.
  const maxStepsPerFrame = (speed: number) => Math.ceil((speed * SIM_TICK_HZ) / 60) + 1;
  const STATS_INTERVAL_MS = 1000;
  const MIRROR_INTERVAL_MS = 1000;
  let simAccumulator = 0;
  let lastSimClock = performance.now();
  let ticksThisSecond = 0;
  let ticksPerSecond = 0;
  let statsSecondClock = performance.now();
  let lastStatsAt = 0;
  let lastMirrorAt = 0;
  let sampleNext = false; // time the next suitable tick on the GPU (can carry over frames)
  let mirrorRetry = false; // last mirror was dropped as stale — fetch again even if nothing's eroded since
  let lastVolume = 0;
  let lastMaxDepth = 0;
  let lastMinDepth = 0;
  let erosionLine = 'erosion: —';
  // Conservation baseline (brief §3): loose + exported should stay at this
  // value until the next CPU-side terrain edit, which resets it.
  let massBaseline: { serial: number; total: number } | null = null;

  function runTick(sample: boolean): void {
    gpuTimer.beginTick(sample);
    const encoder = gpu!.device.createCommandEncoder();
    const waterBufs = sim.encode(encoder, SIM_TICK_DT, gpuTimer.pass('water'));
    erosion.encode(encoder, SIM_TICK_DT, waterBufs, gpuTimer);
    gpuTimer.resolve(encoder);
    gpu!.device.queue.submit([encoder.finish()]);
    sim.afterSubmit();
    erosion.afterSubmit();
    gpuTimer.afterSubmit();
  }

  function requestStats(): void {
    sim.requestStats((s) => {
      lastVolume = s.totalVolume;
      lastMaxDepth = s.maxDepth;
      lastMinDepth = s.minDepth;
    });
    const serial = terrainEditSerial;
    erosion.requestStats((e) => {
      if (serial !== terrainEditSerial) return; // a brush edit landed mid-flight — this sample straddles it
      const total = e.looseVolume + e.exportedVolume;
      if (!massBaseline || massBaseline.serial !== serial) massBaseline = { serial, total };
      const drift = massBaseline.total !== 0 ? ((total - massBaseline.total) / Math.abs(massBaseline.total)) * 100 : 0;
      const negative = Math.min(e.minEarth, e.minSand, e.minSuspended);
      erosionLine =
        `erosion: hydraulic ${erosion.settings.hydraulic ? 'on' : 'off'}, slump ${erosion.settings.slumping ? 'on' : 'off'} | loose ${e.looseVolume.toFixed(0)} drift ${drift >= 0 ? '+' : ''}${drift.toExponential(1)}%` +
        ` | susp ${e.suspendedVolume.toFixed(1)} max ${e.maxSuspended.toPrecision(2)}` +
        ` | out ${e.exportedVolume.toFixed(1)} | Δmax ${e.maxTickChange.toPrecision(2)}/tick, slump ${e.maxSlumpChange.toPrecision(2)}` +
        (negative < 0 ? ` | NEGATIVE ${negative.toPrecision(2)}` : '');
    });
  }

  function refreshMirror(now: number): void {
    if (isPainting || now - lastMirrorAt < MIRROR_INTERVAL_MS) return;
    if (!erosion.isDirty() && !mirrorRetry) return;
    lastMirrorAt = now;
    const serial = terrainEditSerial;
    erosion.requestMirror((earth, sand) => {
      // A brush edit after the copy was taken would be overwritten by it —
      // drop it and fetch again next interval.
      if (serial !== terrainEditSerial || isPainting) {
        mirrorRetry = true;
        return;
      }
      mirrorRetry = false;
      const cur = currentTerrainData;
      cur.earth.set(earth);
      cur.sand.set(sand);
      for (let i = 0; i < currentSurfaceHeight.length; i++) {
        currentSurfaceHeight[i] = cur.rock[i]! + earth[i]! + sand[i]!;
      }
    });
  }

  function stepSim(): void {
    const now = performance.now();
    simAccumulator += Math.min((now - lastSimClock) / 1000, 0.25) * simSpeed;
    lastSimClock = now;

    if (now - lastStatsAt >= STATS_INTERVAL_MS) {
      lastStatsAt = now;
      requestStats();
      sampleNext = true;
    }
    refreshMirror(now);

    const maxSteps = maxStepsPerFrame(simSpeed);
    let steps = 0;
    while (simAccumulator >= SIM_TICK_DT && steps < maxSteps) {
      // Time a tick that includes slumping when it's on (it runs every 4th
      // tick), so its cost shows up in the gpu ms line; otherwise any tick.
      const timeThis = sampleNext && (!erosion.settings.slumping || erosion.nextTickSlumps());
      runTick(timeThis);
      if (timeThis) sampleNext = false;
      simAccumulator -= SIM_TICK_DT;
      steps++;
      ticksThisSecond++;
    }
    if (steps === maxSteps) simAccumulator = 0; // maxed out — shed the backlog, let sim time slip

    if (steps > 0) water.setWaterBufferIndex(sim.currentWaterIndex());

    if (now - statsSecondClock >= 1000) {
      ticksPerSecond = ticksThisSecond;
      ticksThisSecond = 0;
      statsSecondClock = now;
    }
    const timings = gpuTimer.latest();
    const gpuLine = timings
      ? `gpu ms: ${timings.map((t) => `${t.label} ${t.ms.toFixed(2)}`).join(' · ')}`
      : `gpu ms: ${gpuTimer.perPass ? 'waiting' : 'n/a'}`;
    diagnostics.setSimStats(
      `water: vol ${lastVolume.toFixed(0)} | depth ${lastMinDepth.toFixed(2)}..${lastMaxDepth.toFixed(2)} | ${ticksPerSecond} ticks/s — ${simSpeed}× asked, ${(ticksPerSecond / SIM_TICK_HZ).toFixed(1)}× actual\n` +
        `${erosionLine}\n${gpuLine}`
    );
  }

  function tick() {
    stepSim();

    const aspect = gpu!.canvas.width / gpu!.canvas.height;
    const viewProj = camera.viewProjection(aspect);
    terrain.updateUniforms(viewProj, lightDir, currentSeaLevel);
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

function unionBox(a: BoundingBox | null, b: BoundingBox): BoundingBox {
  if (!a) return { ...b };
  return {
    colMin: Math.min(a.colMin, b.colMin),
    colMax: Math.max(a.colMax, b.colMax),
    rowMin: Math.min(a.rowMin, b.rowMin),
    rowMax: Math.max(a.rowMax, b.rowMax),
  };
}

main().catch((err) => diagnostics.showFatal(`Unhandled startup error: ${err}`));
