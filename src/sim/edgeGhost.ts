// The world beyond the map edge (D17). Each edge cell has one "ghost" just
// past it: ground frozen at that edge cell's height when the terrain was
// generated. Where that frozen ground is below sea level the ghost is open
// sea — an infinite reservoir at sea level; elsewhere it's dry land that
// water can drain onto but never come back from. The player edits the map,
// never the world beyond it, so the ghosts only change on regeneration.
//
// Ghost heights live in a compact perimeter array, not a full-field one.
// edgeSlot() is the exact arithmetic of edgeSlot() in water.wgsl — keep the
// two in lockstep (same lesson as D12).

/** Perimeter-array length for a cols × rows field. */
export function edgeSlotCount(cols: number, rows: number): number {
  return 2 * cols + 2 * rows;
}

/**
 * Slot of an edge cell's ghost in the perimeter array: top row, then bottom
 * row, then left column, then right column. Corners take their row's slot.
 * Returns -1 for an interior cell.
 */
export function edgeSlot(col: number, row: number, cols: number, rows: number): number {
  if (row === 0) return col;
  if (row === rows - 1) return cols + col;
  if (col === 0) return 2 * cols + row;
  if (col === cols - 1) return 2 * cols + rows + row;
  return -1;
}

/** Snapshot each edge cell's surface height into the perimeter array. */
export function buildEdgeGhostHeights(surfaceHeight: Float32Array, cols: number, rows: number): Float32Array {
  const ghost = new Float32Array(edgeSlotCount(cols, rows));
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const slot = edgeSlot(col, row, cols, rows);
      if (slot >= 0) ghost[slot] = surfaceHeight[row * cols + col]!;
    }
  }
  return ghost;
}
