import { describe, expect, it } from 'vitest';
import { floodFillWater } from './generator';

describe('floodFillWater', () => {
  const width = 10;
  const height = 10;
  const waterLevel = 0;

  it('leaves an enclosed basin dry even though it is below the water level', () => {
    // This is the game's own founding scenario (01-brief.md): a basin below
    // sea level, cut off by a ridge, should stay dry until something
    // connects it — not auto-flood the moment the world is generated.
    const surfaceHeight = new Float32Array(width * height).fill(100);
    const islandIdx = 5 * width + 5; // interior cell with no below-water neighbours
    surfaceHeight[islandIdx] = -10;

    const water = floodFillWater(surfaceHeight, width, height, waterLevel);
    expect(water[islandIdx]).toBe(0);
  });

  it('floods a low region connected to the field boundary', () => {
    const surfaceHeight = new Float32Array(width * height).fill(100);
    const boundaryIdx = 5; // row 0 — touches the field's storage boundary
    surfaceHeight[boundaryIdx] = -10;

    const water = floodFillWater(surfaceHeight, width, height, waterLevel);
    expect(water[boundaryIdx]).toBeCloseTo(10, 5);
  });

  it('floods an entire connected below-water channel, not just the seed cells', () => {
    const surfaceHeight = new Float32Array(width * height).fill(100);
    // A full row below water level, edge to edge — confirms BFS actually
    // propagates through the channel rather than only flagging boundary cells.
    for (let x = 0; x < width; x++) surfaceHeight[3 * width + x] = -5;

    const water = floodFillWater(surfaceHeight, width, height, waterLevel);
    for (let x = 0; x < width; x++) {
      expect(water[3 * width + x]).toBeCloseTo(5, 5);
    }
  });
});
