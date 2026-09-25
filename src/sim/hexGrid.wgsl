// Shared hex-grid arithmetic for every sim shader (water.wgsl, erosion.wgsl).
// Prepended to each module's source at pipeline creation — one copy, so the
// neighbour maths can't drift between the water and erosion passes (D12: the
// parity bug has already bitten the mesh, the shading and the generator).
//
// Everything takes the field size as arguments rather than reading a Params
// struct, because each shader module has its own Params layout.

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
// axialToWorld({q,r}) normalised. Projects per-direction quantities (pipe
// flows, height differences) into a single 2D vector.
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
fn neighborIndex(col: u32, row: u32, d: u32, cols: u32, rows: u32) -> i32 {
  let off = dirOffset(d);
  let q = i32(col) - i32(row) / 2;          // row >= 0, so / 2 == floor(row/2)
  let nr = i32(row) + off.y;
  if (nr < 0 || nr >= i32(rows)) { return -1; }
  let ncol = q + off.x + nr / 2;
  if (ncol < 0 || ncol >= i32(cols)) { return -1; }
  return nr * i32(cols) + ncol;
}

// Slot of an edge cell in a perimeter-sized array: top row, bottom row, left
// column, right column; corners take their row's slot. Exact arithmetic of
// edgeSlot() in src/sim/edgeGhost.ts (unit-tested) — keep in lockstep.
// Only ever called for cells that have an off-field pipe, i.e. edge cells.
fn edgeSlot(col: u32, row: u32, cols: u32, rows: u32) -> u32 {
  if (row == 0u) { return col; }
  if (row == rows - 1u) { return cols + col; }
  if (col == 0u) { return 2u * cols + row; }
  return 2u * cols + rows + row; // col == cols - 1
}
