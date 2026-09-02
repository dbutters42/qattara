// Relief shading theme — the hypsometric (elevation → colour) palette plus the
// handful of scalars that control how strongly it reads.
//
// A theme is PURE DATA. Swapping it — a high-contrast accessibility palette, a
// dark/light variant, a stepped "contour band" palette — rebuilds a 1-D lookup
// row on the CPU (`buildReliefLUT`) and re-uploads it to one small texture; the
// shader (`terrain.wgsl`) never changes, it just samples the transfer function.
// `TerrainPipeline.setReliefTheme` is the runtime hook for a future theme
// picker. Only one theme (CLASSIC_ATLAS) exists today.

export interface ColorStop {
  /** Position along this ramp, 0..1. For both ramps 0 = sea level; 1 = the
   *  deepest (`below`) or highest (`above`) point the ramp resolves. */
  at: number;
  /** RGB, 0..1, in the same space the rest of the shader works in (plain
   *  sRGB-ish — no gamma handling anywhere in this project yet). */
  color: [number, number, number];
}

export interface ReliefTheme {
  name: string;
  /** Sea level (`at` 0) down to the deepest expected height (`at` 1). */
  below: ColorStop[];
  /** Sea level (`at` 0) up to the highest expected height (`at` 1). */
  above: ColorStop[];
  /** World-height each ramp spans from sea level. Heights past the end clamp
   *  to the last stop, so these don't have to match the generator exactly —
   *  just be roomy enough that the extremes aren't a flat band. */
  belowSpan: number;
  aboveSpan: number;
  /** How much exposed-material colour (rock/earth/sand) bleeds through the
   *  elevation tint: 0 = pure hypsometric, 1 = pure material. */
  materialMix: number;
}

// Classic world-atlas hypsometric tint: blues below sea level; green lowland
// rising through yellow and brown to pale grey-white highlands. Deliberately
// the familiar physical-map reading of "how high is this", not a literal
// biome — per Dane, biome fidelity is a non-goal here.
export const CLASSIC_ATLAS: ReliefTheme = {
  name: 'classic-atlas',
  below: [
    { at: 0.0, color: [0.62, 0.79, 0.86] }, // just below sea level — pale shelf blue
    { at: 0.5, color: [0.31, 0.5, 0.68] },
    { at: 1.0, color: [0.15, 0.27, 0.45] }, // deep — dark blue
  ],
  above: [
    { at: 0.0, color: [0.44, 0.63, 0.38] }, // shoreline green
    { at: 0.22, color: [0.6, 0.72, 0.4] },
    { at: 0.45, color: [0.83, 0.79, 0.47] }, // yellow
    { at: 0.68, color: [0.7, 0.53, 0.35] }, // brown
    { at: 0.86, color: [0.53, 0.42, 0.34] }, // dark brown
    { at: 1.0, color: [0.92, 0.91, 0.9] }, // pale rock / snow
  ],
  belowSpan: 80,
  aboveSpan: 110,
  materialMix: 0.2,
};

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function sampleRamp(stops: readonly ColorStop[], u: number): [number, number, number] {
  const first = stops[0]!;
  const last = stops[stops.length - 1]!;
  if (u <= first.at) return [...first.color];
  if (u >= last.at) return [...last.color];
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i]!;
    const b = stops[i + 1]!;
    if (u >= a.at && u <= b.at) {
      const t = (u - a.at) / (b.at - a.at || 1);
      return [
        a.color[0] + (b.color[0] - a.color[0]) * t,
        a.color[1] + (b.color[1] - a.color[1]) * t,
        a.color[2] + (b.color[2] - a.color[2]) * t,
      ];
    }
  }
  return [...last.color];
}

/**
 * Bake a theme into a 1-D RGBA8 lookup row.
 *
 * Sea level sits on the boundary between the two halves. Texel `half - 1` is
 * sea level from the `below` side, texel `half` is sea level from the `above`
 * side; the left edge is `belowSpan` deep, the right edge is `aboveSpan` high.
 * `terrain.wgsl` maps a cell's height to a texel with the identical convention.
 *
 * `width` must be even so sea level lands cleanly on the half boundary.
 */
export function buildReliefLUT(theme: ReliefTheme, width = 512): Uint8Array {
  if (width % 2 !== 0) throw new Error('relief LUT width must be even');
  const out = new Uint8Array(width * 4);
  const half = width / 2;
  const denom = half - 1 || 1;

  for (let x = 0; x < width; x++) {
    const rgb =
      x < half
        ? sampleRamp(theme.below, (half - 1 - x) / denom) // sea level at x=half-1, deepest at x=0
        : sampleRamp(theme.above, (x - half) / denom); // sea level at x=half, highest at x=width-1
    out[x * 4 + 0] = Math.round(clamp01(rgb[0]) * 255);
    out[x * 4 + 1] = Math.round(clamp01(rgb[1]) * 255);
    out[x * 4 + 2] = Math.round(clamp01(rgb[2]) * 255);
    out[x * 4 + 3] = 255;
  }
  return out;
}
