import { fbm, ridgedFbm, SimplexNoise2D, type FractalParams } from './noise';
import { AXIAL_DIRECTIONS, storageCol } from '../hex/coords';

export interface TerrainGenParams {
  width: number;
  height: number;
  seed: number;

  /** 0 = smooth rolling hills, 1 = sharp rugged ridges with dramatic elevation jumps. */
  ruggedness: number;
  /** How far terrain can drop below height 0, in world units. */
  depthRange: number;
  /** How far terrain can rise above height 0, in world units. */
  elevationRange: number;
  /** Base feature size in field texels — larger = broader landforms. */
  wavelength: number;
  /** World-unit distance between adjacent texels — from the hex grid (hexSize*sqrt(3) column, hexSize*1.5 row). Needed to turn height differences into real slope angles. */
  worldStepX: number;
  worldStepZ: number;

  /** World height at/below which cells start out flooded. */
  waterLevel: number;

  /** 0..1: how readily slopes expose rock. Higher = rock shows up on gentler slopes too. */
  rockiness: number;
  /** How thick the soil (earth+sand) layer gets at its deepest, in world units. */
  maxSoilDepth: number;
  /** World-unit band around waterLevel where sand dominates over earth (beaches/deltas). */
  sandBand: number;
}

export interface GeneratedTerrain {
  /** Height of the bedrock surface — rock + earth + sand always sums to total terrain height. */
  rock: Float32Array;
  earth: Float32Array;
  sand: Float32Array;
  /** Standing water depth (0 where dry). */
  water: Float32Array;
}

const FRACTAL: FractalParams = { octaves: 5, persistence: 0.5, lacunarity: 2.0 };

// Two macro (large-wavelength, few-octave) layers give the world coherent
// *regions* instead of one texture applied uniformly everywhere. Not
// exposed as sliders yet — these shape the overall structure, distinct from
// the fine per-cell texture the five UI sliders control.
const REGION_FRACTAL: FractalParams = { octaves: 2, persistence: 0.5, lacunarity: 2.0 };
const MACRO_FRACTAL: FractalParams = { octaves: 2, persistence: 0.5, lacunarity: 2.0 };
const REGION_WAVELENGTH = 500; // "character" map: mountain-range regions vs plains regions
const MACRO_WAVELENGTH = 600; // elevation map: basins vs plateaus, at a genuinely large scale
const REGION_RUGGEDNESS_SWING = 0.4; // how far regions can push ruggedness above/below the slider
const REGION_AMPLITUDE_MIN_MULT = 0.3; // plains: flattened well below the slider's range
const REGION_AMPLITUDE_MAX_MULT = 1.8; // mountains: exaggerated well above it
const MACRO_AMPLITUDE_RATIO = 1.5; // macro elevation swings bigger than the fine detail — it should dominate the overall shape

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

// A flat "below waterLevel -> flooded" rule floods every enclosed low point
// regardless of whether water could actually reach it — which would flood
// the game's own founding scenario (a dry basin cut off by a ridge, per
// 01-brief.md) the moment the world is generated. Water only reaches a cell
// if there's a below-waterLevel path to it from outside the modelled world;
// the field's storage boundary stands in for "the sea beyond the map edge".
// Deliberately no size threshold for enclosed basins that don't reach the
// edge — even a large one should stay dry until the player breaches it,
// which is the whole point.
//
// Flood-fill needs genuine hex connectivity, not a naive rectangular one —
// reuses the tested axial neighbour helpers rather than rederiving
// row-parity offsets a fourth time (see D12, docs/design/02-decisions.md).
export function floodFillWater(
  surfaceHeight: Float32Array,
  width: number,
  height: number,
  waterLevel: number
): Float32Array {
  const belowWater = new Uint8Array(width * height);
  for (let i = 0; i < belowWater.length; i++) {
    belowWater[i] = surfaceHeight[i]! <= waterLevel ? 1 : 0;
  }

  const connected = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let qHead = 0;
  let qTail = 0;

  function tryEnqueue(idx: number): void {
    if (belowWater[idx] === 1 && connected[idx] === 0) {
      connected[idx] = 1;
      queue[qTail++] = idx;
    }
  }

  for (let x = 0; x < width; x++) {
    tryEnqueue(x); // row 0
    tryEnqueue((height - 1) * width + x); // last row
  }
  for (let y = 0; y < height; y++) {
    tryEnqueue(y * width); // col 0
    tryEnqueue(y * width + (width - 1)); // last col
  }

  while (qHead < qTail) {
    const idx = queue[qHead++]!;
    const row = Math.floor(idx / width);
    const col = idx - row * width;
    const q = col - Math.floor(row / 2);
    for (const dir of AXIAL_DIRECTIONS) {
      const nq = q + dir.q;
      const nr = row + dir.r;
      if (nr < 0 || nr >= height) continue;
      const ncol = storageCol({ q: nq, r: nr });
      if (ncol < 0 || ncol >= width) continue;
      tryEnqueue(nr * width + ncol);
    }
  }

  const water = new Float32Array(width * height);
  for (let i = 0; i < water.length; i++) {
    water[i] = connected[i] === 1 ? Math.max(0, waterLevel - surfaceHeight[i]!) : 0;
  }
  return water;
}

export function generateTerrain(params: TerrainGenParams): GeneratedTerrain {
  const {
    width,
    height,
    seed,
    ruggedness,
    depthRange,
    elevationRange,
    wavelength,
    worldStepX,
    worldStepZ,
    waterLevel,
    rockiness,
    maxSoilDepth,
    sandBand,
  } = params;
  const noise = new SimplexNoise2D(seed);
  // Distinct seeds (not the same noise field re-sampled at another scale) so
  // region character and macro elevation vary independently — a region can
  // be a flat high plateau or a rugged low badland, not just "high = rugged".
  const regionNoise = new SimplexNoise2D(seed + 1013);
  const macroNoise = new SimplexNoise2D(seed + 7919);

  const surfaceHeight = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // 0..1 map of "how mountainous is this region" — modulates the local
      // ruggedness/amplitude around the slider values rather than applying
      // one global setting everywhere.
      const regionT = (fbm(regionNoise, x / REGION_WAVELENGTH, y / REGION_WAVELENGTH, REGION_FRACTAL) + 1) / 2;
      const localRuggedness = Math.min(Math.max(ruggedness + (regionT - 0.5) * 2 * REGION_RUGGEDNESS_SWING, 0), 1);
      const localAmplitudeMult = lerp(REGION_AMPLITUDE_MIN_MULT, REGION_AMPLITUDE_MAX_MULT, regionT);

      const nx = x / wavelength;
      const ny = y / wavelength;
      const smooth = fbm(noise, nx, ny, FRACTAL); // [-1, 1]
      const ridged = ridgedFbm(noise, nx, ny, FRACTAL) * 2 - 1; // remapped to [-1, 1] so the blend is apples-to-apples
      const shaped = lerp(smooth, ridged, localRuggedness);
      const fineShape = shaped * localAmplitudeMult;

      // A separate, larger-scale elevation layer — real basins and plateaus
      // are macro-scale features; high-frequency noise alone rarely
      // produces a large, clean, closed depression on its own.
      const macroShape = fbm(macroNoise, x / MACRO_WAVELENGTH, y / MACRO_WAVELENGTH, MACRO_FRACTAL) * MACRO_AMPLITUDE_RATIO; // roughly [-1.5, 1.5]

      // Combine in unitless "shape" space first, then scale by depth or
      // elevation range depending on which side of height 0 it lands on —
      // this is what makes them independently tunable rather than one
      // symmetric amplitude. Whichever range is larger dominates that side
      // of the terrain; region/macro relative weighting is unaffected.
      const rawShape = fineShape + macroShape;
      surfaceHeight[y * width + x] = rawShape >= 0 ? rawShape * elevationRange : rawShape * depthRange;
    }
  }

  const water = floodFillWater(surfaceHeight, width, height, waterLevel);

  const rock = new Float32Array(width * height);
  const earth = new Float32Array(width * height);
  const sand = new Float32Array(width * height);

  // Slope thresholds as real angles (tan), independent of amplitude — slope
  // is a rise/run ratio, not an absolute height, so scaling it by amplitude
  // was dimensionally wrong (it made a 60-unit-tall world need a >40 degree
  // incline before any rock appeared at all, regardless of how rugged that
  // terrain visually was). Rockiness shifts both angles: 0 -> rock from
  // 30 deg to 55 deg; 1 -> rock from 12 deg to 30 deg.
  const startAngle = lerp(30, 12, rockiness) * (Math.PI / 180);
  const fullAngle = lerp(55, 30, rockiness) * (Math.PI / 180);
  const slopeStart = Math.tan(startAngle);
  const slopeFull = Math.tan(fullAngle);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const h = surfaceHeight[idx]!;

      // Central-difference slope, same technique the fragment shader uses
      // for normals — generation-time material placement should agree with
      // what the erosion sim will later see as "steep". Left/right (same
      // row) are genuine hex neighbours regardless of parity; up/down need
      // a column offset that flips with row parity, exactly as in
      // terrain.wgsl's normal calc — using a fixed offset here would bias
      // slope (and so material placement) in a regular directional pattern.
      const xm = Math.max(x - 1, 0);
      const xp = Math.min(x + 1, width - 1);
      const rowEven = (y & 1) === 0;
      const upCol = Math.min(Math.max(rowEven ? x : x + 1, 0), width - 1);
      const downCol = Math.min(Math.max(rowEven ? x - 1 : x, 0), width - 1);
      const ym = Math.max(y - 1, 0);
      const yp = Math.min(y + 1, height - 1);
      const hL = surfaceHeight[y * width + xm]!;
      const hR = surfaceHeight[y * width + xp]!;
      const hU = surfaceHeight[yp * width + upCol]!;
      const hD = surfaceHeight[ym * width + downCol]!;
      // True rise/run (tan of the slope angle), matching the shader's
      // normal-derivative calculation — not raw per-texel height delta.
      const slope = Math.hypot((hR - hL) / (2 * worldStepX), (hU - hD) / (2 * worldStepZ));

      // Steeper slope -> less soil clings on -> more exposed rock. Soil
      // is a thin veneer over bedrock, not a fraction of the total
      // (possibly very negative, in a basin) terrain height.
      const rockFraction = smoothstep(slopeStart, slopeFull, slope);
      const soilDepth = maxSoilDepth * (1 - rockFraction);

      // Within that soil layer, low ground near the water line silts up
      // with sand (beaches, deltas); higher ground stays earth.
      const sandFractionOfSoil = 1 - smoothstep(0, sandBand, h - waterLevel);
      const sandDepth = soilDepth * sandFractionOfSoil;
      const earthDepth = soilDepth - sandDepth;

      rock[idx] = h - soilDepth;
      earth[idx] = earthDepth;
      sand[idx] = sandDepth;
    }
  }

  return { rock, earth, sand, water };
}
