import { describe, expect, it } from 'vitest';
import { fbm, ridgedFbm, SimplexNoise2D } from './noise';

describe('SimplexNoise2D', () => {
  it('is deterministic for a given seed', () => {
    const a = new SimplexNoise2D(42);
    const b = new SimplexNoise2D(42);
    expect(a.noise2D(1.23, 4.56)).toBe(b.noise2D(1.23, 4.56));
  });

  it('produces different fields for different seeds', () => {
    const a = new SimplexNoise2D(1);
    const b = new SimplexNoise2D(2);
    expect(a.noise2D(1.23, 4.56)).not.toBe(b.noise2D(1.23, 4.56));
  });

  it('stays within [-1, 1] over a broad sample', () => {
    const n = new SimplexNoise2D(7);
    for (let x = -50; x < 50; x += 1.7) {
      for (let y = -50; y < 50; y += 2.3) {
        const v = n.noise2D(x, y);
        expect(v).toBeGreaterThanOrEqual(-1);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('fbm / ridgedFbm', () => {
  const params = { octaves: 5, persistence: 0.5, lacunarity: 2 };

  it('fbm stays within a sane range', () => {
    const n = new SimplexNoise2D(3);
    for (let x = 0; x < 20; x += 0.9) {
      const v = fbm(n, x, x * 0.5, params);
      expect(v).toBeGreaterThanOrEqual(-1.5);
      expect(v).toBeLessThanOrEqual(1.5);
    }
  });

  it('ridgedFbm stays within [0, 1]', () => {
    const n = new SimplexNoise2D(3);
    for (let x = 0; x < 20; x += 0.9) {
      const v = ridgedFbm(n, x, x * 0.5, params);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});
