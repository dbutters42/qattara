import { describe, expect, it } from 'vitest';
import { buildReliefLUT, CLASSIC_ATLAS, type ReliefTheme } from './reliefTheme';

const px = (lut: Uint8Array, x: number) => [lut[x * 4]!, lut[x * 4 + 1]!, lut[x * 4 + 2]!, lut[x * 4 + 3]!];
const to255 = (c: number) => Math.round(c * 255);

describe('buildReliefLUT', () => {
  it('rejects an odd width (sea level must land on the half boundary)', () => {
    expect(() => buildReliefLUT(CLASSIC_ATLAS, 511)).toThrow();
  });

  it('fills every texel opaque and the right length', () => {
    const lut = buildReliefLUT(CLASSIC_ATLAS, 64);
    expect(lut.length).toBe(64 * 4);
    for (let x = 0; x < 64; x++) expect(px(lut, x)[3]).toBe(255);
  });

  it('puts the ramp endpoints where the shader convention expects them', () => {
    const w = 64;
    const half = w / 2;
    const lut = buildReliefLUT(CLASSIC_ATLAS, w);

    // x = 0 → deepest `below` stop; x = half-1 → sea level from below
    expect(px(lut, 0).slice(0, 3)).toEqual(CLASSIC_ATLAS.below.at(-1)!.color.map(to255));
    expect(px(lut, half - 1).slice(0, 3)).toEqual(CLASSIC_ATLAS.below[0]!.color.map(to255));
    // x = half → sea level from above; x = w-1 → highest `above` stop
    expect(px(lut, half).slice(0, 3)).toEqual(CLASSIC_ATLAS.above[0]!.color.map(to255));
    expect(px(lut, w - 1).slice(0, 3)).toEqual(CLASSIC_ATLAS.above.at(-1)!.color.map(to255));
  });

  it('interpolates linearly between two stops at the midpoint', () => {
    const theme: ReliefTheme = {
      name: 't',
      below: [{ at: 0, color: [0, 0, 0] }, { at: 1, color: [0, 0, 0] }],
      above: [
        { at: 0, color: [0, 0, 0] },
        { at: 1, color: [1, 0, 0] },
      ],
      belowSpan: 10,
      aboveSpan: 10,
      materialMix: 0,
    };
    const w = 66; // half = 33, so above ramp texels are x=33..65, u = (x-33)/32
    const lut = buildReliefLUT(theme, w);
    // u = 0.5 → x = 33 + 16 = 49 → red ≈ 128
    expect(px(lut, 49)[0]).toBeGreaterThanOrEqual(126);
    expect(px(lut, 49)[0]).toBeLessThanOrEqual(130);
  });
});
