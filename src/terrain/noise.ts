// Seeded 2D simplex noise, plus fractal (fBm) and ridged variants for terrain
// shaping. Simplex over classic Perlin specifically because it's isotropic —
// no axis-aligned bias — which matches the whole reason the hex grid was
// chosen over a square one (see D8 in docs/design/02-decisions.md).
// Reference: Stefan Gustavson, "Simplex noise demystified" (2005).

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GRAD2: readonly (readonly [number, number])[] = [
  [1, 1], [-1, 1], [1, -1], [-1, -1],
  [1, 0], [-1, 0], [1, 0], [-1, 0],
  [0, 1], [0, -1], [0, 1], [0, -1],
];

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

export class SimplexNoise2D {
  private perm = new Uint8Array(512);

  constructor(seed: number) {
    const rand = mulberry32(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = p[i]!;
      p[i] = p[j]!;
      p[j] = tmp;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255]!;
  }

  // Returns a value in roughly [-1, 1].
  noise2D(x: number, y: number): number {
    const s = (x + y) * F2;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const t = (i + j) * G2;
    const x0 = x - (i - t);
    const y0 = y - (j - t);

    const i1 = x0 > y0 ? 1 : 0;
    const j1 = x0 > y0 ? 0 : 1;

    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;

    const ii = i & 255;
    const jj = j & 255;
    const gi0 = this.perm[ii + this.perm[jj]!]! % 12;
    const gi1 = this.perm[ii + i1 + this.perm[jj + j1]!]! % 12;
    const gi2 = this.perm[ii + 1 + this.perm[jj + 1]!]! % 12;

    return 70 * (corner(x0, y0, gi0) + corner(x1, y1, gi1) + corner(x2, y2, gi2));
  }
}

function corner(x: number, y: number, gi: number): number {
  let t = 0.5 - x * x - y * y;
  if (t < 0) return 0;
  t *= t;
  const [gx, gy] = GRAD2[gi]!;
  return t * t * (gx * x + gy * y);
}

export interface FractalParams {
  octaves: number;
  /** Amplitude multiplier per octave — lower means higher octaves contribute less. */
  persistence: number;
  /** Frequency multiplier per octave — higher means finer detail layers in faster. */
  lacunarity: number;
}

// Rotating each octave's sample coordinates by a different angle decorrelates
// any single octave's directional bias from reinforcing across the sum.
// Classic simplex noise's zero-crossings can align subtly with its
// underlying triangular lattice — invisible in ordinary signed noise, but
// exposed as regular parallel ridges once ridgedFbm's `1 - abs(noise)`
// transform specifically highlights those zero-crossings. Not a
// domain-specific hack: this is the standard fix for exactly this artifact.
const OCTAVE_ROTATION = 0.5; // radians per octave — arbitrary but non-resonant with the grid

function rotate(x: number, y: number, angle: number): [number, number] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [x * c - y * s, x * s + y * c];
}

/** Standard fractional Brownian motion. Returns roughly [-1, 1]. Reads as smooth, rolling terrain. */
export function fbm(noise: SimplexNoise2D, x: number, y: number, p: FractalParams): number {
  let amplitude = 1;
  let frequency = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < p.octaves; o++) {
    const [rx, ry] = rotate(x * frequency, y * frequency, o * OCTAVE_ROTATION);
    sum += noise.noise2D(rx, ry) * amplitude;
    norm += amplitude;
    amplitude *= p.persistence;
    frequency *= p.lacunarity;
  }
  return sum / norm;
}

/**
 * Ridged multifractal: folds noise around zero and sharpens it, the standard
 * technique for jagged ridgelines and dramatic elevation jumps rather than
 * fBm's rolling hills. Returns roughly [0, 1], ridges near 1.
 */
export function ridgedFbm(noise: SimplexNoise2D, x: number, y: number, p: FractalParams): number {
  let amplitude = 1;
  let frequency = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < p.octaves; o++) {
    const [rx, ry] = rotate(x * frequency, y * frequency, o * OCTAVE_ROTATION);
    const n = 1 - Math.abs(noise.noise2D(rx, ry));
    sum += n * n * amplitude;
    norm += amplitude;
    amplitude *= p.persistence;
    frequency *= p.lacunarity;
  }
  return sum / norm;
}
