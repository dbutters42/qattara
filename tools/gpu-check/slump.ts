// Headless check: M4 thermal slumping (pass 7). Run: npm run test:gpu
//
// Flat rock with a 20 m sand tower, a 20 m earth tower and a 20 m rock
// pillar, no water, hydraulic off. The sand should settle at its angle of
// repose, the earth visibly steeper, the rock not at all — and the piles
// should come fully to rest rather than creeping forever.

import { createHarness, check, driftPct, DRIFT_LIMIT_PCT, finish, HEX_SIZE } from './setup';
import { DEFAULT_EROSION_SETTINGS } from '../../src/sim/erosionSim';
import { storageNeighborIndex } from '../../src/hex/coords';

const N = 96;
const TICKS = 2800; // the towers are fully at rest by ~2400

const rock = new Float32Array(N * N);
const earth = new Float32Array(N * N);
const sand = new Float32Array(N * N);
for (let r = 0; r < N; r++) {
  for (let c = 0; c < N; c++) {
    const i = r * N + c;
    if (Math.hypot(c - 25, r - 48) < 6) sand[i] = 20;
    if (Math.hypot(c - 70, r - 48) < 6) earth[i] = 20;
    if (Math.hypot(c - 48, r - 15) < 3) rock[i] = 20;
  }
}

console.log('\nsand / earth / rock towers slumping');
const h = await createHarness(N, { rock, earth, sand });
h.erosion.settings.hydraulic = false;

const first = await h.stats();
const baseline = first.looseVolume + first.exportedVolume;
let worstDrift = 0;
let lastSlump = Infinity;
for (let t = 0; t < TICKS; t += 400) {
  await h.run(400);
  const s = await h.stats();
  worstDrift = Math.max(worstDrift, Math.abs(driftPct(s, baseline)));
  lastSlump = s.maxSlumpChange;
}

// Steepest drop from each material's cells to any neighbour.
const m = await h.mirror();
const pipeLength = Math.sqrt(3) * HEX_SIZE;
let sandDeg = 0;
let earthDeg = 0;
let rockCovered = 0;
for (let r = 0; r < N; r++) {
  for (let c = 0; c < N; c++) {
    const i = r * N + c;
    const hi = rock[i]! + m.earth[i]! + m.sand[i]!;
    if (rock[i]! > 0 && m.earth[i]! + m.sand[i]! > 1e-3) rockCovered++;
    for (let d = 0; d < 6; d++) {
      const ni = storageNeighborIndex(c, r, d, N, N);
      if (ni < 0) continue;
      const deg = (Math.atan((hi - (rock[ni]! + m.earth[ni]! + m.sand[ni]!)) / pipeLength) * 180) / Math.PI;
      if (m.sand[i]! > 1e-3) sandDeg = Math.max(sandDeg, deg);
      else if (m.earth[i]! > 1e-3) earthDeg = Math.max(earthDeg, deg);
    }
  }
}

const { talusSandDeg, talusEarthDeg } = DEFAULT_EROSION_SETTINGS;
check(h.errors.length === 0, 'no GPU validation errors', h.errors[0] ?? 'none');
check(Math.abs(sandDeg - talusSandDeg) < 0.5, `sand settles at ~${talusSandDeg}°`, `steepest ${sandDeg.toFixed(1)}°`);
check(Math.abs(earthDeg - talusEarthDeg) < 0.5, `earth holds at ~${talusEarthDeg}°`, `steepest ${earthDeg.toFixed(1)}°`);
check(rockCovered === 0, 'rock pillar stays bare (rock never moves, nothing lands on a 20 m spike)', `${rockCovered} cells covered`);
check(lastSlump === 0, 'piles come fully to rest', `last max slump ${lastSlump}`);
check(worstDrift < DRIFT_LIMIT_PCT, 'loose material conserved', `worst |drift| ${worstDrift.toExponential(1)} %`);
finish();
