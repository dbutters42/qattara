// M3 water simulation — virtual-pipes model (Mei, Decaudin & Hu 2007),
// adapted from square to hex. See docs/design/05-m3-brief.md.
//
// Three compute passes per tick, in this order, one submit:
//   cs_input  — rain + springs, in place on waterSrc
//   cs_flux   — outflow to each of 6 hex neighbours + the stability clamp,
//               in place on the flux buffer
//   cs_water  — net flow -> new depth (waterSrc -> waterDst), then
//               evaporation and the derived velocity, both per-cell
//
// Terrain height is read-only here (M3 does no erosion). It lives in the
// render pipeline's height texture; this sim only samples it.

struct Params {
  dt: f32,
  rainRate: f32,       // depth per second added everywhere when rainEnabled
  rainEnabled: f32,    // 0 or 1
  evapRate: f32,       // fraction of depth lost per second

  gravity: f32,
  pipeArea: f32,       // virtual-pipe cross-section (tuning knob)
  pipeLength: f32,     // centre-to-centre distance, = sqrt(3) * hexSize
  cellArea: f32,       // hex cell area, = (3*sqrt(3)/2) * hexSize^2

  fieldCols: u32,
  fieldRows: u32,
  springCount: u32,
  fluxDamping: f32,    // per-tick multiplier on against-gradient (sloshing) flux only, <1 — see cs_flux

  // (col, row, ratePerSecond, _) — hardcoded test sources for M3.
  springs: array<vec4<f32>, 8>,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var heightTex: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> waterSrc: array<f32>;
@group(0) @binding(3) var<storage, read_write> waterDst: array<f32>;
@group(0) @binding(4) var<storage, read_write> flux: array<f32>;      // 6 per cell
@group(0) @binding(5) var<storage, read_write> velocity: array<f32>;  // 2 per cell

// Axial neighbour offsets (dq, dr), same order and meaning as
// AXIAL_DIRECTIONS in src/hex/coords.ts. opposite(d) == (d + 3) % 6.
fn dirOffset(d: u32) -> vec2<i32> {
  var dirs = array<vec2<i32>, 6>(
    vec2<i32>(1, 0), vec2<i32>(1, -1), vec2<i32>(0, -1),
    vec2<i32>(-1, 0), vec2<i32>(-1, 1), vec2<i32>(0, 1),
  );
  return dirs[d];
}

// World-space unit vector of each axial direction (pointy-top), from
// axialToWorld({q,r}) normalised. Used only to project the 6 pipe flows
// into a single velocity vector — nothing in M3 consumes it, but M4 will.
fn dirWorld(d: u32) -> vec2<f32> {
  let s = 0.8660254; // sqrt(3)/2
  var w = array<vec2<f32>, 6>(
    vec2<f32>(1.0, 0.0), vec2<f32>(0.5, -s), vec2<f32>(-0.5, -s),
    vec2<f32>(-1.0, 0.0), vec2<f32>(-0.5, s), vec2<f32>(0.5, s),
  );
  return w[d];
}

// Row-parity-correct neighbour index in storage space, or -1 if off-field.
// This is the exact arithmetic of storageNeighborIndex() in
// src/hex/coords.ts (which is unit-tested) — keep the two in lockstep. D12.
fn neighborIndex(col: u32, row: u32, d: u32) -> i32 {
  let off = dirOffset(d);
  let q = i32(col) - i32(row) / 2;          // row >= 0, so / 2 == floor(row/2)
  let nr = i32(row) + off.y;
  if (nr < 0 || nr >= i32(params.fieldRows)) { return -1; }
  let ncol = q + off.x + nr / 2;
  if (ncol < 0 || ncol >= i32(params.fieldCols)) { return -1; }
  return nr * i32(params.fieldCols) + ncol;
}

fn texelOf(index: i32) -> vec2<i32> {
  let cols = i32(params.fieldCols);
  return vec2<i32>(index % cols, index / cols);
}

fn inField(gid: vec3<u32>) -> bool {
  return gid.x < params.fieldCols && gid.y < params.fieldRows;
}

@compute @workgroup_size(8, 8, 1)
fn cs_input(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (!inField(gid)) { return; }
  let i = gid.y * params.fieldCols + gid.x;

  var w = waterSrc[i];
  w += params.rainEnabled * params.rainRate * params.dt;

  for (var s = 0u; s < params.springCount; s = s + 1u) {
    let sp = params.springs[s];
    if (u32(sp.x) == gid.x && u32(sp.y) == gid.y) {
      w += sp.z * params.dt;
    }
  }

  waterSrc[i] = w;
}

@compute @workgroup_size(8, 8, 1)
fn cs_flux(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (!inField(gid)) { return; }
  let i = gid.y * params.fieldCols + gid.x;

  let wHere = waterSrc[i];
  let terrainHere = textureLoad(heightTex, vec2<i32>(i32(gid.x), i32(gid.y)), 0).r;
  let surfHere = terrainHere + wHere;

  // Accumulate the tentative new outflow to each neighbour. A pipe to an
  // off-field neighbour carries nothing (reflective boundary).
  var newF = array<f32, 6>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
  var totalOutRate = 0.0;
  for (var d = 0u; d < 6u; d = d + 1u) {
    let ni = neighborIndex(gid.x, gid.y, d);
    if (ni < 0) { continue; }
    let t = texelOf(ni);
    let nSurf = textureLoad(heightTex, t, 0).r + waterSrc[ni];
    let dh = surfHere - nSurf;
    // Directional damping: a pipe flowing downhill (dh > 0) carries its
    // accumulated flux forward undamped, so the inrush keeps its speed. A
    // pipe still pushing toward a now-higher surface (dh <= 0) is slosh
    // momentum overshooting equilibrium — bleed it hard so the water settles
    // instead of rocking back and forth.
    let damp = select(1.0, params.fluxDamping, dh <= 0.0);
    let f = max(0.0, damp * flux[i * 6u + d] + params.dt * params.gravity * params.pipeArea * dh / params.pipeLength);
    newF[d] = f;
    totalOutRate = totalOutRate + f;
  }

  // The clamp — outline §3.5 step 2, "the single most important line". A cell
  // may never route out more water than it currently holds this tick.
  let totalOutVol = totalOutRate * params.dt;
  let storedVol = wHere * params.cellArea;
  var k = 1.0;
  if (totalOutVol > 1e-8) {
    k = min(1.0, storedVol / totalOutVol);
  }

  for (var d = 0u; d < 6u; d = d + 1u) {
    flux[i * 6u + d] = newF[d] * k;
  }
}

@compute @workgroup_size(8, 8, 1)
fn cs_water(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (!inField(gid)) { return; }
  let i = gid.y * params.fieldCols + gid.x;

  var inflow = 0.0;
  var outflow = 0.0;
  var vel = vec2<f32>(0.0, 0.0);
  for (var d = 0u; d < 6u; d = d + 1u) {
    let out_d = flux[i * 6u + d];
    outflow = outflow + out_d;

    let ni = neighborIndex(gid.x, gid.y, d);
    var in_d = 0.0;
    if (ni >= 0) {
      in_d = flux[u32(ni) * 6u + ((d + 3u) % 6u)]; // neighbour's outflow toward us
    }
    inflow = inflow + in_d;
    vel = vel + dirWorld(d) * (out_d - in_d);
  }

  let wOld = waterSrc[i];
  var wNew = wOld + params.dt * (inflow - outflow) / params.cellArea;
  wNew = max(0.0, wNew * (1.0 - params.evapRate * params.dt));
  waterDst[i] = wNew;

  // Velocity = net flow vector / (pipe length * mean depth). Clamped depth
  // so shallow cells don't produce absurd speeds. Not read in M3.
  let depthForVel = max(0.5 * (wOld + wNew), 1e-4);
  velocity[i * 2u + 0u] = vel.x / (params.pipeLength * depthForVel);
  velocity[i * 2u + 1u] = vel.y / (params.pipeLength * depthForVel);
}
