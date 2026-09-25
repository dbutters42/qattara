// M4 hydraulic erosion — passes 4 and 5 of docs/design/03-outline.md §3.5,
// on top of the M3 pipe model. See docs/design/06-m4-brief.md.
//
// The sim owns the terrain from here (brief §4.1): `rock` / `earth` / `sand`
// are storage buffers, and cs_compose writes the render/water textures from
// them. Brush edits still happen on the CPU and are copied into these
// buffers by region (erosionSim.ts).
//
// Entry points, in tick order:
//   cs_erode    — pass 4: pick up / set down material, in place
//   cs_advect   — pass 5: move suspended material with the water flux, A -> B
//   cs_compose  — height/earth/sand buffers -> the textures everything reads
// Plus, off the per-tick path:
//   cs_drop     — hydraulic switched off: suspended load settles where it is
//   cs_reduce   — per-row sums/extremes for the conservation HUD
//
// Amounts are all heights (world units of material per cell), the same unit
// as earth/sand, so "move 0.1 from sand to suspSand" conserves exactly.
//
// Each entry point is built with layout 'auto', so it only binds what it
// uses — keeps every pipeline under the default 8-storage-buffers limit.

struct Params {
  dt: f32,
  capacity: f32,     // Kc — how much material fast water on a slope can carry
  erodeSand: f32,    // Ks — rate sand is lifted toward capacity, 1/s
  erodeEarth: f32,   // Ke — rate earth is lifted, once the sand is gone, 1/s
  deposit: f32,      // Kd — rate an over-capacity load settles, 1/s
  minTilt: f32,      // sin(tilt) floor, so fast water on the flat still carries a little
  fullDepth: f32,    // water depth at which carrying capacity reaches full strength
  pipeLength: f32,   // centre-to-centre distance, = sqrt(3) * hexSize
  cellArea: f32,
  fieldCols: u32,
  fieldRows: u32,
  recordStats: u32,  // 1 on ticks whose stats get read back
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var heightTex: texture_2d<f32>;
@group(0) @binding(2) var<storage, read> rock: array<f32>;
@group(0) @binding(3) var<storage, read_write> earth: array<f32>;
@group(0) @binding(4) var<storage, read_write> sand: array<f32>;
@group(0) @binding(5) var<storage, read_write> suspSand: array<f32>;     // current / advection source
@group(0) @binding(6) var<storage, read_write> suspEarth: array<f32>;
@group(0) @binding(7) var<storage, read_write> suspSandOut: array<f32>;  // advection destination
@group(0) @binding(8) var<storage, read_write> suspEarthOut: array<f32>;
@group(0) @binding(9) var<storage, read> water: array<f32>;              // depth after this tick's flow
@group(0) @binding(10) var<storage, read> waterBefore: array<f32>;       // depth the flux was computed from
@group(0) @binding(11) var<storage, read> flux: array<f32>;              // 6 per cell
@group(0) @binding(12) var<storage, read> velocity: array<f32>;          // 2 per cell
@group(0) @binding(13) var<storage, read_write> exported: array<f32>;    // perimeter, see edgeSlot
@group(0) @binding(14) var<storage, read_write> statsAtomic: array<atomic<u32>, 4>;
@group(0) @binding(15) var heightOut: texture_storage_2d<r32float, write>;
@group(0) @binding(16) var earthOut: texture_storage_2d<r32float, write>;
@group(0) @binding(17) var sandOut: texture_storage_2d<r32float, write>;
@group(0) @binding(18) var<storage, read_write> partials: array<vec4<f32>>; // 2 per row

fn inField(gid: vec3<u32>) -> bool {
  return gid.x < params.fieldCols && gid.y < params.fieldRows;
}

fn texelOf(index: i32) -> vec2<i32> {
  let cols = i32(params.fieldCols);
  return vec2<i32>(index % cols, index / cols);
}

// ---------------------------------------------------------------------------
// Pass 4 — erosion / deposition.
//
// Carrying capacity C = Kc · sin(tilt) · |v| · depthFactor. If the water holds
// less than C it picks material up; if more, it sets some down. Rock is never
// touched — earth and sand can't go below zero, so the bed can't go below
// the rock.
@compute @workgroup_size(8, 8, 1)
fn cs_erode(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (!inField(gid)) { return; }
  let i = gid.y * params.fieldCols + gid.x;
  let here = vec2<i32>(i32(gid.x), i32(gid.y));

  // Tilt from the 6-neighbour height gradient. With six unit directions e_d
  // at distance L, Σ e_d e_dᵀ = 3·I, so the least-squares gradient is
  // (1 / 3L) · Σ (h_d − h) · e_d. An off-field neighbour counts as level.
  let h = textureLoad(heightTex, here, 0).r;
  var g = vec2<f32>(0.0, 0.0);
  for (var d = 0u; d < 6u; d = d + 1u) {
    let ni = neighborIndex(gid.x, gid.y, d, params.fieldCols, params.fieldRows);
    if (ni < 0) { continue; }
    let hn = textureLoad(heightTex, texelOf(ni), 0).r;
    g = g + dirWorld(d) * (hn - h);
  }
  g = g / (3.0 * params.pipeLength);
  let slope2 = dot(g, g);
  let sinTilt = max(sqrt(slope2 / (1.0 + slope2)), params.minTilt);

  let v = vec2<f32>(velocity[i * 2u], velocity[i * 2u + 1u]);
  // A film of rain on a hillside moves fast but shouldn't carry like a river:
  // capacity ramps up with depth until `fullDepth`.
  let depthFactor = clamp(water[i] / params.fullDepth, 0.0, 1.0);
  let cap = params.capacity * sinTilt * length(v) * depthFactor;

  var s = sand[i];
  var e = earth[i];
  var ss = suspSand[i];
  var se = suspEarth[i];
  let carried = ss + se;

  if (cap > carried) {
    // Spare capacity: lift material. Sand always goes first — earth is only
    // touched once this cell's sand is gone. That ordering *is* armouring:
    // water strips the sand from a mixed bed and leaves the earth behind.
    // Stability line 1 (brief §4.4): never take more than is there, or more
    // than the spare capacity.
    var spare = cap - carried;
    let takeSand = min(min(params.erodeSand * spare * params.dt, spare), s);
    s = s - takeSand;
    ss = ss + takeSand;
    spare = spare - takeSand;
    if (s <= 0.0 && spare > 0.0) {
      let takeEarth = min(min(params.erodeEarth * spare * params.dt, spare), e);
      e = e - takeEarth;
      se = se + takeEarth;
    }
  } else if (carried > 0.0) {
    // Over capacity: settle some of the load, split in proportion to what's
    // suspended. Can't set down more than is carried.
    let dep = min(params.deposit * (carried - cap) * params.dt, carried);
    let depSand = min(dep * (ss / carried), ss);
    let depEarth = min(dep - depSand, se);
    ss = ss - depSand;
    se = se - depEarth;
    s = s + depSand;
    e = e + depEarth;
  }

  if (params.recordStats != 0u) {
    // Largest single-tick bed change on the map — an early warning of a
    // blow-up before it's visible. Non-negative floats order the same as
    // their bit patterns, so atomicMax on the bits is a float max.
    let change = abs((s + e) - (sand[i] + earth[i]));
    if (change > 0.0) {
      atomicMax(&statsAtomic[0], bitcast<u32>(change));
    }
  }

  sand[i] = s;
  earth[i] = e;
  suspSand[i] = ss;
  suspEarth[i] = se;
}

// ---------------------------------------------------------------------------
// Pass 5 — sediment advection. Grid-native and flux-based (brief §4.3): the
// suspended load moves with the water, in the same proportions pass 2 moved
// the water. Cell i sends fraction flux_d·dt / storedVolume along each pipe,
// and receives each neighbour's send toward it. Sender and receiver compute
// the same fraction from the same numbers, so suspended mass is conserved
// by construction.
//
// Stability line 2 (brief §4.4): the fractions come from `waterBefore`, the
// depth pass 2 derived the flux from. Pass 2's clamp already guarantees the
// total sent is ≤ what's stored, so the fractions sum to ≤ 1.
//
// Map edge (D17, brief §4.5): load riding water off the map — off a land
// edge or into the sea — leaves with it and is tallied in `exported`. Sea
// inflow (negative off-field flux) brings water but no sediment.
fn sendFraction(f: f32, storedDepth: f32) -> f32 {
  return f * params.dt / max(storedDepth * params.cellArea, 1e-12);
}

@compute @workgroup_size(8, 8, 1)
fn cs_advect(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (!inField(gid)) { return; }
  let i = gid.y * params.fieldCols + gid.x;

  let wHere = waterBefore[i];
  var sent = 0.0;
  var offMap = 0.0;
  var inSand = 0.0;
  var inEarth = 0.0;
  for (var d = 0u; d < 6u; d = d + 1u) {
    let f = flux[i * 6u + d];
    let ni = neighborIndex(gid.x, gid.y, d, params.fieldCols, params.fieldRows);
    if (ni < 0) {
      if (f > 0.0) {
        let fr = sendFraction(f, wHere);
        sent = sent + fr;
        offMap = offMap + fr;
      }
      continue;
    }
    if (f > 0.0) {
      sent = sent + sendFraction(f, wHere);
    }
    let n = u32(ni);
    let fIn = flux[n * 6u + ((d + 3u) % 6u)];
    if (fIn > 0.0) {
      let fr = sendFraction(fIn, waterBefore[n]);
      inSand = inSand + suspSand[n] * fr;
      inEarth = inEarth + suspEarth[n] * fr;
    }
  }

  let keep = max(0.0, 1.0 - sent);
  let ss = suspSand[i];
  let se = suspEarth[i];
  suspSandOut[i] = ss * keep + inSand;
  suspEarthOut[i] = se * keep + inEarth;

  if (offMap > 0.0) {
    let slot = edgeSlot(gid.x, gid.y, params.fieldCols, params.fieldRows);
    exported[slot] = exported[slot] + (ss + se) * offMap;
  }
}

// ---------------------------------------------------------------------------
// Buffers -> the textures the terrain renderer and the water sim read.
@compute @workgroup_size(8, 8, 1)
fn cs_compose(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (!inField(gid)) { return; }
  let i = gid.y * params.fieldCols + gid.x;
  let t = vec2<i32>(i32(gid.x), i32(gid.y));
  let e = earth[i];
  let s = sand[i];
  textureStore(heightOut, t, vec4<f32>(rock[i] + e + s, 0.0, 0.0, 0.0));
  textureStore(earthOut, t, vec4<f32>(e, 0.0, 0.0, 0.0));
  textureStore(sandOut, t, vec4<f32>(s, 0.0, 0.0, 0.0));
}

// Hydraulic erosion switched off (D22): whatever the water was carrying
// settles in place, so nothing is lost and the terrain simply freezes.
@compute @workgroup_size(8, 8, 1)
fn cs_drop(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (!inField(gid)) { return; }
  let i = gid.y * params.fieldCols + gid.x;
  sand[i] = sand[i] + suspSand[i];
  earth[i] = earth[i] + suspEarth[i];
  suspSand[i] = 0.0;
  suspEarth[i] = 0.0;
}

// ---------------------------------------------------------------------------
// Conservation readout: one workgroup per row, tree-reduced. Writes two vec4
// per row:
//   [2r]   = (Σ earth+sand+suspended, Σ suspended, max suspended, _)
//   [2r+1] = (min earth, min sand, min suspended, _)
// The CPU adds the rows in double precision.
const REDUCE_WG = 256u;
var<workgroup> wgSum: array<vec4<f32>, 256>;
var<workgroup> wgMin: array<vec4<f32>, 256>;

@compute @workgroup_size(256, 1, 1)
fn cs_reduce(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {
  let row = wid.x;
  var sum = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  var mn = vec4<f32>(3.0e38, 3.0e38, 3.0e38, 0.0);
  for (var col = lid.x; col < params.fieldCols; col = col + REDUCE_WG) {
    let i = row * params.fieldCols + col;
    let susp = suspSand[i] + suspEarth[i];
    sum.x = sum.x + earth[i] + sand[i] + susp;
    sum.y = sum.y + susp;
    sum.z = max(sum.z, susp);
    mn.x = min(mn.x, earth[i]);
    mn.y = min(mn.y, sand[i]);
    mn.z = min(mn.z, min(suspSand[i], suspEarth[i]));
  }
  wgSum[lid.x] = sum;
  wgMin[lid.x] = mn;
  workgroupBarrier();

  for (var stride = REDUCE_WG / 2u; stride > 0u; stride = stride / 2u) {
    if (lid.x < stride) {
      let a = wgSum[lid.x];
      let b = wgSum[lid.x + stride];
      wgSum[lid.x] = vec4<f32>(a.x + b.x, a.y + b.y, max(a.z, b.z), 0.0);
      wgMin[lid.x] = min(wgMin[lid.x], wgMin[lid.x + stride]);
    }
    workgroupBarrier();
  }

  if (lid.x == 0u) {
    partials[row * 2u] = wgSum[0];
    partials[row * 2u + 1u] = wgMin[0];
  }
}
