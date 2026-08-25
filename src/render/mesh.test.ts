import { describe, expect, it } from 'vitest';
import { buildHexMesh } from './mesh';

describe('buildHexMesh', () => {
  const hexSize = 2;
  const meshCols = 8;
  const mesh = buildHexMesh({ meshCols, meshRows: 8, fieldCols: 16, fieldRows: 16, hexSize });

  function vertexAt(i: number, j: number): { x: number; z: number } {
    const idx = (j * meshCols + i) * 4;
    return { x: mesh.vertices[idx]!, z: mesh.vertices[idx + 1]! };
  }

  function dist(a: { x: number; z: number }, b: { x: number; z: number }): number {
    return Math.hypot(a.x - b.x, a.z - b.z);
  }

  it('staggers adjacent mesh rows by one field-column step, not zero', () => {
    // Regression test: subsampling every-other row with a fixed column
    // offset silently collapses the hex stagger into a plain rectangular
    // grid, since same-parity rows are already mutually aligned.
    for (let i = 0; i < meshCols - 1; i++) {
      const row0 = vertexAt(i, 0);
      const row1 = vertexAt(i, 1);
      expect(row1.x - row0.x).toBeCloseTo(mesh.worldStepX, 5);
    }
  });

  it('keeps same-parity rows aligned (that part is correct, not a bug)', () => {
    for (let i = 0; i < meshCols - 1; i++) {
      expect(vertexAt(i, 2).x).toBeCloseTo(vertexAt(i, 0).x, 5);
    }
  });

  it('picks the geometrically shorter diagonal on both even and odd rows', () => {
    // Regression test: a fixed diagonal cut is correct for half the rows and
    // produces sheared (non-equilateral) triangles on the other half —
    // exactly the square-grid diagonal-bias artifact hex grids are meant to
    // avoid (D8, docs/design/02-decisions.md).
    for (let j = 0; j < 4; j++) {
      const a = vertexAt(2, j);
      const b = vertexAt(3, j);
      const c = vertexAt(2, j + 1);
      const d = vertexAt(3, j + 1);
      const diagBC = dist(b, c);
      const diagAD = dist(a, d);
      if (j % 2 === 0) {
        expect(diagBC).toBeLessThan(diagAD);
      } else {
        expect(diagAD).toBeLessThan(diagBC);
      }
    }
  });
});
