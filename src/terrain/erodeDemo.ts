import { SimplexNoise2D } from './noise';
import { floodFillWater, type GeneratedTerrain } from './generator';

// Repeatable M4 erosion scenario (docs/design/06-m4-brief.md §3.1), opt-in via
// `?demo=erode`. Hand-built rather than a generator seed: fully
// deterministic, and shaped to exercise the brief's §3 criteria in one map —
// a spring near the top of a long even slope should cut a channel down it
// (incision), and where that channel reaches the sea it should drop its load
// and build outward (delta / deposition).
//
// Profile along each row (west → east, i.e. increasing column):
//
//   plateau ───────┐
//   rock top 50    └──╲  even slope, 60 m over 400 cells (~2.5°)
//                       ╲
//   sea level 0 ─ ─ ─ ─ ─ ╲─ shoreline ~col 660 ─ ─ ─ ─ ─ ─ ─ ─
//                            ╲____ sea floor, gently deepening to the east edge
//
// Everything is covered in 3 m of earth with 1 m of sand mixed in, so the
// water has both materials to work on (sand goes first — armouring). A little
// rock roughness gives the flow something to choose a channel from; on a
// perfect plane it would spread as an even sheet.

export const ERODE_DEMO_SEA_LEVEL = 0;

/** The single hardcoded source: on the slope just below the plateau edge, mid-map. */
export const ERODE_DEMO_SPRING = { col: 320, row: 512, ratePerSecond: 200 } as const;

const PLATEAU_END = 300;
const SLOPE_END = 700;
const PLATEAU_ROCK = 50;
const SLOPE_FOOT_ROCK = -10;
const EDGE_ROCK = -25;
const EARTH_DEPTH = 3;
const SAND_DEPTH = 1;
const NOISE_SEED = 4;

export function buildErodeDemoTerrain(size: number): GeneratedTerrain {
  const n = size * size;
  const rock = new Float32Array(n);
  const earth = new Float32Array(n);
  const sand = new Float32Array(n);
  const noise = new SimplexNoise2D(NOISE_SEED);

  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      let base: number;
      if (col < PLATEAU_END) {
        base = PLATEAU_ROCK;
      } else if (col < SLOPE_END) {
        base = PLATEAU_ROCK + ((SLOPE_FOOT_ROCK - PLATEAU_ROCK) * (col - PLATEAU_END)) / (SLOPE_END - PLATEAU_END);
      } else {
        base = SLOPE_FOOT_ROCK + ((EDGE_ROCK - SLOPE_FOOT_ROCK) * (col - SLOPE_END)) / (size - 1 - SLOPE_END);
      }
      // Two octaves of gentle roughness, well under the slope's 0.15 m/cell
      // drop — enough to steer the water, not enough to pond it.
      const rough = 0.4 * noise.noise2D(col / 20, row / 20) + 0.15 * noise.noise2D(col / 6 + 100, row / 6);
      const i = row * size + col;
      rock[i] = base + rough;
      earth[i] = EARTH_DEPTH;
      sand[i] = SAND_DEPTH;
    }
  }

  const surface = new Float32Array(n);
  for (let i = 0; i < n; i++) surface[i] = rock[i]! + earth[i]! + sand[i]!;
  const water = floodFillWater(surface, size, size, ERODE_DEMO_SEA_LEVEL);

  return { rock, earth, sand, water };
}
