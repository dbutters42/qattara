import { describe, expect, it } from 'vitest';
import { buildErodeDemoTerrain, ERODE_DEMO_SEA_LEVEL, ERODE_DEMO_SPRING } from './erodeDemo';

const SIZE = 1024;
const t = buildErodeDemoTerrain(SIZE);
const surface = (col: number, row: number) => {
  const i = row * SIZE + col;
  return t.rock[i]! + t.earth[i]! + t.sand[i]!;
};

describe('?demo=erode terrain', () => {
  it('is deterministic', () => {
    const again = buildErodeDemoTerrain(SIZE);
    let mismatches = 0;
    for (let i = 0; i < t.rock.length; i++) if (again.rock[i] !== t.rock[i]) mismatches++;
    expect(mismatches).toBe(0);
  });

  it('puts the spring on dry, downhill-sloping ground', () => {
    const { col, row } = ERODE_DEMO_SPRING;
    expect(surface(col, row)).toBeGreaterThan(ERODE_DEMO_SEA_LEVEL);
    expect(t.water[row * SIZE + col]).toBe(0);
    expect(surface(col + 20, row)).toBeLessThan(surface(col, row));
  });

  it('descends from the plateau to a sea at the east edge', () => {
    const row = ERODE_DEMO_SPRING.row;
    expect(surface(100, row)).toBeGreaterThan(50);
    expect(t.water[row * SIZE + 100]).toBe(0);
    expect(t.water[row * SIZE + SIZE - 1]).toBeGreaterThan(0);
    // Roughly monotonic down the slope: sampled every 20 cells.
    for (let col = 320; col < 680; col += 20) {
      expect(surface(col + 20, row)).toBeLessThan(surface(col, row));
    }
  });

  it('floods only the connected sea — shoreline between the slope and the east edge', () => {
    const row = ERODE_DEMO_SPRING.row;
    let shore = -1;
    for (let col = 0; col < SIZE; col++) {
      if (t.water[row * SIZE + col]! > 0) {
        shore = col;
        break;
      }
    }
    expect(shore).toBeGreaterThan(600);
    expect(shore).toBeLessThan(720);
  });

  it('covers everything in earth with sand mixed in', () => {
    expect(Math.min(...t.earth.subarray(0, SIZE))).toBeGreaterThan(0);
    expect(Math.min(...t.sand.subarray(0, SIZE))).toBeGreaterThan(0);
  });
});
