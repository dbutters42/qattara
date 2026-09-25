// Headless check: M4 hydraulic erosion (passes 4 + 5). Run: npm run test:gpu
//
// A 128² tilted plane dropping along +col — rock under 2 m of soil, sand on
// the top half and earth on the bottom half — fed by two springs at the
// high edge. Three scenarios:
//   1. springs only, all edges dry land
//   2. springs + rain, with the low edge below sea level (D17 sea)
//   3. like 1, but hydraulic switched off partway (D22)

import { createHarness, check, driftPct, DRIFT_LIMIT_PCT, finish, type SimOptions, type Terrain } from './setup';

const N = 128;

function slope(): Terrain {
  const rock = new Float32Array(N * N);
  const earth = new Float32Array(N * N);
  const sand = new Float32Array(N * N);
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const i = r * N + c;
      rock[i] = 40 - c * 0.5 + Math.sin(r * 0.3) * 0.5 + Math.cos(c * 0.7 + r * 0.2) * 0.3;
      earth[i] = r < N / 2 ? 0.5 : 2;
      sand[i] = r < N / 2 ? 1.5 : 0;
    }
  }
  return { rock, earth, sand };
}

const SPRINGS = [
  { col: 4, row: N >> 2, ratePerSecond: 50 },
  { col: 4, row: (3 * N) >> 2, ratePerSecond: 50 },
];

async function scenario(name: string, opts: SimOptions, ticks: number, switchOffAt?: number): Promise<void> {
  console.log(`\n${name}`);
  const terrain = slope();
  const before = { earth: terrain.earth.slice(), sand: terrain.sand.slice() };
  const h = await createHarness(N, terrain, opts);
  h.erosion.settings.slumping = false; // hydraulic on its own; slump.ts covers pass 7

  const first = await h.stats();
  const baseline = first.looseVolume + first.exportedVolume;
  let worstDrift = 0;
  let worstNegative = 0;
  let maxSuspended = 0;
  let afterOff: { loose: number; exported: number } | null = null;
  let frozen = true;

  for (let t = 0; t < ticks; t += 100) {
    if (switchOffAt !== undefined && t === switchOffAt) h.erosion.settings.hydraulic = false;
    await h.run(100);
    const s = await h.stats();
    worstDrift = Math.max(worstDrift, Math.abs(driftPct(s, baseline)));
    worstNegative = Math.min(worstNegative, s.minEarth, s.minSand, s.minSuspended);
    maxSuspended = Math.max(maxSuspended, s.suspendedVolume);
    if (switchOffAt !== undefined && t >= switchOffAt) {
      if (!afterOff) afterOff = { loose: s.looseVolume, exported: s.exportedVolume };
      else if (s.looseVolume !== afterOff.loose || s.exportedVolume !== afterOff.exported || s.suspendedVolume !== 0) frozen = false;
    }
  }

  const m = await h.mirror();
  let deepest = 0;
  for (let i = 0; i < N * N; i++) {
    deepest = Math.min(deepest, m.earth[i]! + m.sand[i]! - (before.earth[i]! + before.sand[i]!));
  }

  check(h.errors.length === 0, 'no GPU validation errors', h.errors[0] ?? 'none');
  check(worstDrift < DRIFT_LIMIT_PCT, 'loose + exported conserved', `worst |drift| ${worstDrift.toExponential(1)} %`);
  check(worstNegative >= 0, 'nothing negative', `min earth/sand/suspended ${worstNegative}`);
  check(deepest < -0.1, 'water actually cut the bed', `deepest cut ${deepest.toFixed(2)} m`);
  check(maxSuspended > 0, 'water carried a load', `peak suspended ${maxSuspended.toFixed(1)}`);
  if (switchOffAt !== undefined) {
    check(frozen && afterOff !== null, 'switching off settles the load and freezes the terrain', frozen ? 'frozen' : 'still changing');
  }
}

await scenario('1. springs, dry-land edges', { springs: SPRINGS }, 600);
await scenario('2. springs + rain, sea at the low edge', { springs: SPRINGS, rain: true, seaLevel: 0 }, 600);
await scenario('3. hydraulic switched off at tick 300', { springs: SPRINGS }, 600, 300);
finish();
