import { describe, expect, it } from 'vitest';
import {
  AXIAL_DIRECTIONS,
  axialToWorld,
  neighbor,
  oppositeDirection,
  storageCol,
  storageIndex,
  storageNeighborIndex,
  worldToAxial,
} from './coords';

describe('AXIAL_DIRECTIONS', () => {
  it('has six directions, each the exact opposite of the one three steps away', () => {
    expect(AXIAL_DIRECTIONS).toHaveLength(6);
    for (let i = 0; i < 6; i++) {
      const a = AXIAL_DIRECTIONS[i]!;
      const b = AXIAL_DIRECTIONS[(i + 3) % 6]!;
      expect(a.q + b.q).toBe(0);
      expect(a.r + b.r).toBe(0);
    }
  });

  it('neighbor() walks in the direction and back again', () => {
    const start = { q: 3, r: -2 };
    for (let dir = 0; dir < 6; dir++) {
      const n = neighbor(start, dir);
      const back = neighbor(n, (dir + 3) % 6);
      expect(back).toEqual(start);
    }
  });
});

describe('axialToWorld / worldToAxial round trip', () => {
  const size = 7.5;

  it('recovers the exact cell from its own centre', () => {
    for (let r = -20; r <= 20; r += 3) {
      for (let q = -20; q <= 20; q += 3) {
        const a = { q, r };
        const { x, y } = axialToWorld(a, size);
        expect(worldToAxial(x, y, size)).toEqual(a);
      }
    }
  });

  it('recovers the same cell from a point nudged toward its centre', () => {
    const a = { q: 5, r: -3 };
    const { x, y } = axialToWorld(a, size);
    // Nudge by less than half a cell width in each direction — still inside the same hex.
    expect(worldToAxial(x + 1, y - 1, size)).toEqual(a);
  });

  it('neighbouring cells are closer to their own centre than to this one', () => {
    const a = { q: 0, r: 0 };
    for (let dir = 0; dir < 6; dir++) {
      const n = neighbor(a, dir);
      const { x, y } = axialToWorld(n, size);
      expect(worldToAxial(x, y, size)).toEqual(n);
    }
  });
});

describe('storageIndex', () => {
  it('matches the documented formula array[r][q + floor(r/2)]', () => {
    const width = 100;
    expect(storageIndex({ q: 4, r: 6 }, width)).toBe(6 * width + (4 + Math.floor(6 / 2)));
    expect(storageIndex({ q: -3, r: -5 }, width)).toBe(-5 * width + (-3 + Math.floor(-5 / 2)));
  });

  it('gives every cell in a rectangular block a unique index', () => {
    const width = 64;
    const seen = new Set<number>();
    for (let r = 0; r < 32; r++) {
      for (let q = -16; q < 16; q++) {
        const idx = storageIndex({ q, r }, width);
        expect(seen.has(idx)).toBe(false);
        seen.add(idx);
      }
    }
  });
});

describe('oppositeDirection', () => {
  it('is (dir + 3) mod 6, and normalises out-of-range input', () => {
    for (let d = 0; d < 6; d++) expect(oppositeDirection(d)).toBe((d + 3) % 6);
    expect(oppositeDirection(6)).toBe(oppositeDirection(0));
    expect(oppositeDirection(-1)).toBe(oppositeDirection(5));
  });
});

describe('storageNeighborIndex', () => {
  const COLS = 64;
  const ROWS = 48;

  // The independent reference: go via axial space using the already-tested
  // helpers. storage (col,row) -> axial -> step -> storage index.
  function viaAxial(col: number, row: number, dir: number): number {
    const a = { q: col - Math.floor(row / 2), r: row };
    const n = neighbor(a, dir);
    if (n.r < 0 || n.r >= ROWS) return -1;
    const ncol = storageCol(n);
    if (ncol < 0 || ncol >= COLS) return -1;
    return n.r * COLS + ncol;
  }

  it('matches the axial-space reference for every in-field cell and direction, both row parities', () => {
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        for (let dir = 0; dir < 6; dir++) {
          expect(storageNeighborIndex(col, row, dir, COLS, ROWS)).toBe(viaAxial(col, row, dir));
        }
      }
    }
  });

  it('reports -1 past every edge rather than wrapping or going out of bounds', () => {
    let offFieldCount = 0;
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        for (let dir = 0; dir < 6; dir++) {
          const idx = storageNeighborIndex(col, row, dir, COLS, ROWS);
          if (idx === -1) {
            offFieldCount++;
          } else {
            expect(idx).toBeGreaterThanOrEqual(0);
            expect(idx).toBeLessThan(COLS * ROWS);
          }
        }
      }
    }
    expect(offFieldCount).toBeGreaterThan(0); // edges of a finite field do have missing neighbours
  });

  it('stepping in dir then the opposite dir returns to the start, for cells whose neighbour exists', () => {
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const start = row * COLS + col;
        for (let dir = 0; dir < 6; dir++) {
          const n = storageNeighborIndex(col, row, dir, COLS, ROWS);
          if (n === -1) continue;
          const nCol = n % COLS;
          const nRow = (n - nCol) / COLS;
          expect(storageNeighborIndex(nCol, nRow, oppositeDirection(dir), COLS, ROWS)).toBe(start);
        }
      }
    }
  });
});
