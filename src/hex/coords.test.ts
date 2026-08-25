import { describe, expect, it } from 'vitest';
import { AXIAL_DIRECTIONS, axialToWorld, neighbor, storageIndex, worldToAxial } from './coords';

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
