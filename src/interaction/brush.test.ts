import { describe, expect, it } from 'vitest';
import { applyBrush, type MaterialArrays } from './brush';

function flatMaterials(size: number, rockHeight: number): MaterialArrays {
  return {
    rock: new Float32Array(size * size).fill(rockHeight),
    earth: new Float32Array(size * size),
    sand: new Float32Array(size * size),
  };
}

describe('applyBrush — smooth/ruggedize', () => {
  const fieldSize = 32;
  const hexSize = 2;
  const worldStepX = hexSize * Math.sqrt(3);
  const worldStepZ = hexSize * 1.5;

  it('ruggedize does not blow up within a single application (regression: in-place neighbour feedback)', () => {
    // A single short tap should never produce a spike anywhere near the
    // magnitude of a runaway feedback loop — this is exactly the bug a
    // screenshot caught: a single tap punched a vertical spike far above
    // the rest of the terrain.
    const materials = flatMaterials(fieldSize, 0);
    // Some existing variation for ruggedize to amplify, otherwise a
    // perfectly flat field has nothing to diverge from.
    for (let i = 0; i < materials.rock.length; i++) {
      materials.rock[i] = (i % 7) - 3; // small, bounded variation
    }

    applyBrush('ruggedize', 0, 16, materials, fieldSize, fieldSize, hexSize, worldStepX, worldStepZ, {
      radius: 40,
      strength: 0.3,
      steepness: 0,
      material: 'earth',
    });

    for (const h of materials.rock) {
      expect(Math.abs(h)).toBeLessThan(50); // nowhere near a runaway spike
    }
  });

  it('a shared touchedCellsThisStroke set makes repeated applications a no-op after the first (regression: holding/tracing in place)', () => {
    // The in-place-feedback fix only covered a single call — the follow-up
    // bug was that many pointer events firing while a finger holds or
    // traces the same spot each independently applied ruggedize, and since
    // it's a divergent operator (pushes away from the neighbour average),
    // repeated applications compounded without limit. The actual fix is the
    // caller (main.ts) sharing one Set across the whole stroke so each cell
    // is only ever touched once, however many events land on it.
    const materials = flatMaterials(fieldSize, 0);
    for (let i = 0; i < materials.rock.length; i++) {
      materials.rock[i] = (i % 7) - 3;
    }
    const touchedCellsThisStroke = new Set<number>();

    for (let i = 0; i < 200; i++) {
      applyBrush('ruggedize', 0, 16, materials, fieldSize, fieldSize, hexSize, worldStepX, worldStepZ, {
        radius: 40,
        strength: 0.3,
        steepness: 0,
        material: 'earth',
        touchedCellsThisStroke,
      });
    }

    const oneShot = flatMaterials(fieldSize, 0);
    for (let i = 0; i < oneShot.rock.length; i++) {
      oneShot.rock[i] = (i % 7) - 3;
    }
    applyBrush('ruggedize', 0, 16, oneShot, fieldSize, fieldSize, hexSize, worldStepX, worldStepZ, {
      radius: 40,
      strength: 0.3,
      steepness: 0,
      material: 'earth',
      touchedCellsThisStroke: new Set(),
    });

    // 200 applications with a shared touched-set should match exactly one
    // application — every one after the first was a no-op.
    for (let i = 0; i < materials.rock.length; i++) {
      expect(materials.rock[i]).toBeCloseTo(oneShot.rock[i]!, 5);
    }
  });

  it('smooth reduces local variance', () => {
    const materials = flatMaterials(fieldSize, 0);
    for (let i = 0; i < materials.rock.length; i++) {
      materials.rock[i] = i % 2 === 0 ? 10 : -10; // sharp alternating pattern
    }
    const before = variance(materials.rock);

    applyBrush('smooth', 0, 16, materials, fieldSize, fieldSize, hexSize, worldStepX, worldStepZ, {
      radius: 40,
      strength: 1,
      steepness: 0,
      material: 'earth',
    });

    expect(variance(materials.rock)).toBeLessThan(before);
  });
});

function variance(data: Float32Array): number {
  const mean = data.reduce((a, b) => a + b, 0) / data.length;
  return data.reduce((a, b) => a + (b - mean) ** 2, 0) / data.length;
}
