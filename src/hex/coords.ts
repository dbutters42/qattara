// Axial (q, r) hex coordinates, pointy-top orientation.
// Reference: Red Blob Games, "Hexagonal Grids" (https://www.redblobgames.com/grids/hexagons/).

export interface Axial {
  q: number;
  r: number;
}

// The six neighbour directions are constant in axial coordinates — this is
// the entire reason axial was chosen over offset coordinates, which need a
// different neighbour table for even/odd rows.
export const AXIAL_DIRECTIONS: readonly Axial[] = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
];

export function neighbor(a: Axial, direction: number): Axial {
  const d = AXIAL_DIRECTIONS[((direction % 6) + 6) % 6]!;
  return { q: a.q + d.q, r: a.r + d.r };
}

// Storage index into a rectangular array, per docs/design/03-outline.md 3.2:
// array[r][q + floor(r/2)]. Keeps neighbour math in pure axial space while
// still packing into a flat/rectangular buffer for GPU upload.
export function storageCol(a: Axial): number {
  return a.q + Math.floor(a.r / 2);
}

export function storageIndex(a: Axial, width: number): number {
  return a.r * width + storageCol(a);
}

// Axial -> world position, pointy-top layout. `size` is the hex's
// centre-to-corner radius.
export function axialToWorld(a: Axial, size: number): { x: number; y: number } {
  const x = size * (Math.sqrt(3) * a.q + (Math.sqrt(3) / 2) * a.r);
  const y = size * (1.5 * a.r);
  return { x, y };
}

// World position -> nearest axial cell. Converts to fractional cube
// coordinates, rounds each to the nearest integer, then fixes whichever
// coordinate had the largest rounding error so x + y + z stays exactly 0
// (the standard cube-rounding technique — rounding q/r independently can
// pick the wrong hex right at a cell boundary).
export function worldToAxial(x: number, y: number, size: number): Axial {
  const q = ((Math.sqrt(3) / 3) * x - (1 / 3) * y) / size;
  const r = ((2 / 3) * y) / size;
  return cubeRound(q, r);
}

function cubeRound(qf: number, rf: number): Axial {
  const xf = qf;
  const zf = rf;
  const yf = -xf - zf;

  let x = Math.round(xf);
  let y = Math.round(yf);
  let z = Math.round(zf);

  const xDiff = Math.abs(x - xf);
  const yDiff = Math.abs(y - yf);
  const zDiff = Math.abs(z - zf);

  if (xDiff > yDiff && xDiff > zDiff) {
    x = -y - z;
  } else if (yDiff > zDiff) {
    y = -x - z;
  } else {
    z = -x - y;
  }

  // Normalize -0 (arises from rounding tiny negative floating-point noise
  // produced by the sqrt(3) terms above) to plain 0. Arithmetically
  // identical, but strict equality checks (Object.is, deep-equal in tests)
  // distinguish them, and callers shouldn't have to know about this.
  return { q: x + 0, r: z + 0 };
}
