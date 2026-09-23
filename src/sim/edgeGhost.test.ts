import { describe, expect, it } from 'vitest';
import { buildEdgeGhostHeights, edgeSlot, edgeSlotCount } from './edgeGhost';

describe('edgeSlot', () => {
  it('gives every edge cell a distinct in-range slot and interior cells -1', () => {
    for (const [cols, rows] of [[5, 4], [8, 8], [3, 7]] as const) {
      const seen = new Set<number>();
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const slot = edgeSlot(col, row, cols, rows);
          const onEdge = row === 0 || row === rows - 1 || col === 0 || col === cols - 1;
          if (!onEdge) {
            expect(slot).toBe(-1);
            continue;
          }
          expect(slot).toBeGreaterThanOrEqual(0);
          expect(slot).toBeLessThan(edgeSlotCount(cols, rows));
          expect(seen.has(slot)).toBe(false);
          seen.add(slot);
        }
      }
    }
  });
});

describe('buildEdgeGhostHeights', () => {
  it('copies each edge cell height into its slot', () => {
    const cols = 4;
    const rows = 3;
    const h = new Float32Array(cols * rows).map((_, i) => i * 10);
    const ghost = buildEdgeGhostHeights(h, cols, rows);
    expect(ghost[edgeSlot(2, 0, cols, rows)]).toBe(20); // top row
    expect(ghost[edgeSlot(1, 2, cols, rows)]).toBe(90); // bottom row
    expect(ghost[edgeSlot(0, 1, cols, rows)]).toBe(40); // left column
    expect(ghost[edgeSlot(3, 1, cols, rows)]).toBe(70); // right column
  });
});
