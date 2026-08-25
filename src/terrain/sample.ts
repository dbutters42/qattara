import { worldToAxial } from '../hex/coords';

// Looks up a height-field value at a world (x, z) ground position. Shared
// rather than reimplemented per caller (picking, the brush cursor, and
// likely more later) — it's a short function, but it's exactly the
// axial/storage conversion that's caused real bugs when rederived (D12,
// docs/design/02-decisions.md).
export function sampleHeightField(
  x: number,
  z: number,
  heightField: Float32Array,
  fieldCols: number,
  fieldRows: number,
  hexSize: number
): number | null {
  const { q, r } = worldToAxial(x, z, hexSize);
  const col = q + Math.floor(r / 2);
  if (col < 0 || col >= fieldCols || r < 0 || r >= fieldRows) return null;
  return heightField[r * fieldCols + col]!;
}
