import { axialToWorld } from '../hex/coords';

export interface HexMesh {
  /** Interleaved [x, z, texelCol, texelRow] per vertex — 4 floats, 16 bytes. */
  vertices: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  /** World-space spacing between adjacent mesh columns/rows, for normal derivatives. */
  worldStepX: number;
  worldStepZ: number;
}

export interface HexMeshOptions {
  meshCols: number;
  meshRows: number;
  fieldCols: number;
  fieldRows: number;
  hexSize: number;
}

// Builds a fixed-topology triangular-lattice mesh from hex cell centres.
// Iterating (col, row) directly — rather than axial (q, r) — and deriving
// q = col - floor(row / 2) exactly inverts the storage formula in
// docs/design/03-outline.md 3.2, and happens to cancel the row-offset term
// in axialToWorld for even rows, which is what keeps the mesh's overall
// footprint rectangular instead of a sheared parallelogram.
//
// Because vertex positions already come from axialToWorld, a plain grid
// index buffer over this (col, row) lattice produces genuine equilateral
// triangles with no diagonal bias — the parity handling a square grid would
// need is already absorbed into the per-vertex position, not the topology.
export function buildHexMesh(opts: HexMeshOptions): HexMesh {
  const { meshCols, meshRows, fieldCols, fieldRows, hexSize } = opts;
  const colStep = fieldCols / meshCols;
  const rowStep = fieldRows / meshRows;

  const vertices = new Float32Array(meshCols * meshRows * 4);
  let v = 0;
  for (let j = 0; j < meshRows; j++) {
    const row = Math.floor(j * rowStep);
    for (let i = 0; i < meshCols; i++) {
      const col = Math.floor(i * colStep);
      const q = col - Math.floor(row / 2);
      const { x, y } = axialToWorld({ q, r: row }, hexSize);
      vertices[v++] = x;
      vertices[v++] = y;
      vertices[v++] = col;
      vertices[v++] = row;
    }
  }

  const indices = new Uint32Array((meshCols - 1) * (meshRows - 1) * 6);
  let idx = 0;
  for (let j = 0; j < meshRows - 1; j++) {
    for (let i = 0; i < meshCols - 1; i++) {
      const a = j * meshCols + i;
      const b = a + 1;
      const c = a + meshCols;
      const d = c + 1;
      indices[idx++] = a; indices[idx++] = c; indices[idx++] = b;
      indices[idx++] = b; indices[idx++] = c; indices[idx++] = d;
    }
  }

  return {
    vertices,
    indices,
    vertexCount: meshCols * meshRows,
    // Field-native texel spacing (independent of mesh density) — the
    // fragment shader's normal calc samples adjacent *field* texels, not
    // adjacent mesh vertices. Derived from axialToWorld: moving one column
    // (q+1) shifts x by size*sqrt(3); moving one row shifts y by size*1.5.
    // The latter ignores the half-cell left/right wobble between odd/even
    // rows inherent to this storage layout — a fine approximation for
    // lighting, not for anything that needs exact adjacency.
    worldStepX: hexSize * Math.sqrt(3),
    worldStepZ: hexSize * 1.5,
  };
}
