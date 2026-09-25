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
// Terrain height is read-only here. It lives in the render pipeline's height
// texture, which M4's erosion sim (erosion.wgsl) rewrites from its own
// rock/earth/sand buffers each tick it runs; this sim only samples it.
//
// Map edge (D17): each edge cell's off-field pipes lead to a "ghost" — ground
// frozen at that cell's generation-time height (`ghostHeight`). Below sea
// level the ghost is an infinite sea at `seaLevel`, which can push water in
// or take it out; above, it's dry land water can drain onto but never come
// back from. Off-field pipes carry one *signed* flux (+ out, − in from the
// sea) — see cs_flux / cs_water.

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

  seaLevel: f32,       // surface of the off-map sea (D17); the generator's waterLevel
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var heightTex: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> waterSrc: array<f32>;
@group(0) @binding(3) var<storage, read_write> waterDst: array<f32>;
@group(0) @binding(4) var<storage, read_write> flux: array<f32>;      // 6 per cell
@group(0) @binding(5) var<storage, read_write> velocity: array<f32>;  // 2 per cell
@group(0) @binding(6) var<storage, read> ghostHeight: array<f32>;     // perimeter, see edgeSlot

// dirOffset / dirWorld / neighborIndex / edgeSlot live in hexGrid.wgsl,
// prepended to this source at pipeline creation (shared with erosion.wgsl).

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

  // Accumulate the tentative new outflow to each neighbour.
  var newF = array<f32, 6>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
  var totalOutRate = 0.0;
  for (var d = 0u; d < 6u; d = d + 1u) {
    let ni = neighborIndex(gid.x, gid.y, d, params.fieldCols, params.fieldRows);
    if (ni < 0) {
      // Off-field pipe to the ghost beyond the edge (D17). Same pipe
      // equation, one signed flux. The ghost's surface is the sea where its
      // frozen ground is below sea level, else the dry ground itself.
      let gh = ghostHeight[edgeSlot(gid.x, gid.y, params.fieldCols, params.fieldRows)];
      let isSea = gh <= params.seaLevel;
      let ghostSurf = max(gh, params.seaLevel);
      var f = flux[i * 6u + d] + params.dt * params.gravity * params.pipeArea * (surfHere - ghostSurf) / params.pipeLength;
      if (!isSea) { f = max(0.0, f); } // dry land never sends water back
      newF[d] = f;
      totalOutRate = totalOutRate + max(0.0, f);
      continue;
    }
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

  // Only outflow is scaled. A negative (sea-inflow) off-field flux comes
  // from an infinite reservoir, so there's nothing on its side to clamp.
  for (var d = 0u; d < 6u; d = d + 1u) {
    flux[i * 6u + d] = select(newF[d] * k, newF[d], newF[d] < 0.0);
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
    let f = flux[i * 6u + d];
    var out_d = f;
    var in_d = 0.0;
    let ni = neighborIndex(gid.x, gid.y, d, params.fieldCols, params.fieldRows);
    if (ni >= 0) {
      in_d = flux[u32(ni) * 6u + ((d + 3u) % 6u)]; // neighbour's outflow toward us
    } else {
      // Off-field signed flux (D17): + drains off the map, − is sea inflow.
      out_d = max(0.0, f);
      in_d = max(0.0, -f);
    }
    outflow = outflow + out_d;
    inflow = inflow + in_d;
    vel = vel + dirWorld(d) * (out_d - in_d);
  }

  let wOld = waterSrc[i];
  var wNew = wOld + params.dt * (inflow - outflow) / params.cellArea;
  wNew = max(0.0, wNew * (1.0 - params.evapRate * params.dt));
  waterDst[i] = wNew;

  // Velocity = net flow vector / (pipe length * mean depth). Clamped depth
  // so shallow cells don't produce absurd speeds. Drives M4 erosion capacity.
  let depthForVel = max(0.5 * (wOld + wNew), 1e-4);
  velocity[i * 2u + 0u] = vel.x / (params.pipeLength * depthForVel);
  velocity[i * 2u + 1u] = vel.y / (params.pipeLength * depthForVel);
}
