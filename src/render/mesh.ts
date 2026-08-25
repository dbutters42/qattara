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

// Builds a fixed-topology triangular-lattice mesh from hex cell centres, at a
// coarser density than the underlying field.
//
// A hex lattice's stagger only exists *between* adjacent rows — every other
// row is already mutually aligned with no offset (that's what makes the
// storage formula col = q + floor(r/2) work at all). So subsampling by
// simply picking every Nth row and every Nth column with a *fixed* column
// offset lands only on mutually-aligned rows and silently collapses the
// stagger, producing a plain rectangular grid wearing a hex costume. The fix
// is to treat the coarse mesh as its own hex lattice (cell size = hexSize *
// step) rather than a subset of the fine one: scaling symmetry of
// axialToWorld means the fine-field cell coinciding with coarse axial
// (qc, rc) is exactly (step*qc, step*rc), which — worked through the storage
// formula — makes the correct field column `step*i + (step/2)*(j & 1)`, not
// `step*i`. The `(j & 1)` term is the stagger that was previously missing.
//
// Even with that fixed, a triangle diagonal cut the *same* way every row
// reintroduces the exact square-grid diagonal-bias artifact hex was chosen
// to avoid (D8, docs/design/02-decisions.md) — visible as regular parallel
// creases. Which diagonal is the short (equilateral) one alternates with the
// stagger, so the cut direction must alternate with row parity too.
export function buildHexMesh(opts: HexMeshOptions): HexMesh {
  const { meshCols, meshRows, fieldCols, fieldRows, hexSize } = opts;
  const colStep = fieldCols / meshCols;
  const rowStep = fieldRows / meshRows;
  if (colStep !== rowStep || colStep % 2 !== 0) {
    throw new Error(`buildHexMesh requires equal, even col/row subsampling steps (got ${colStep}, ${rowStep})`);
  }
  const step = colStep;

  const vertices = new Float32Array(meshCols * meshRows * 4);
  let v = 0;
  for (let j = 0; j < meshRows; j++) {
    const row = j * step;
    for (let i = 0; i < meshCols; i++) {
      const col = i * step + (step / 2) * (j & 1);
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
    const a0 = j * meshCols;
    const c0 = a0 + meshCols;
    for (let i = 0; i < meshCols - 1; i++) {
      const a = a0 + i;
      const b = a + 1;
      const c = c0 + i;
      const d = c + 1;
      if ((j & 1) === 0) {
        // Row below shifts right — b and c are the close pair (short diagonal).
        indices[idx++] = a; indices[idx++] = c; indices[idx++] = b;
        indices[idx++] = b; indices[idx++] = c; indices[idx++] = d;
      } else {
        // Row below shifts left — a and d are the close pair instead.
        indices[idx++] = a; indices[idx++] = c; indices[idx++] = d;
        indices[idx++] = a; indices[idx++] = d; indices[idx++] = b;
      }
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
