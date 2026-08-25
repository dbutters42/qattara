// M0 needs just enough relief to prove the displaced-mesh pipeline — not a
// real terrain generator. Single-octave value noise, deterministic (fixed
// seed), replaced entirely once M1 designs the real generator around Dane's
// terrain-input requirements.

function hash2(x: number, y: number, seed: number): number {
  const h = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453123;
  return h - Math.floor(h);
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function valueNoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smoothstep(x - x0);
  const ty = smoothstep(y - y0);

  const v00 = hash2(x0, y0, seed);
  const v10 = hash2(x0 + 1, y0, seed);
  const v01 = hash2(x0, y0 + 1, seed);
  const v11 = hash2(x0 + 1, y0 + 1, seed);

  const a = v00 + (v10 - v00) * tx;
  const b = v01 + (v11 - v01) * tx;
  return a + (b - a) * ty;
}

export interface HeightFieldOptions {
  width: number;
  height: number;
  /** World-space height range in metres (peak-to-trough). */
  amplitude: number;
  /** Larger = broader, smoother hills. */
  wavelength: number;
  seed?: number;
}

export function generateHeightField(opts: HeightFieldOptions): Float32Array {
  const { width, height, amplitude, wavelength, seed = 1 } = opts;
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const n = valueNoise(x / wavelength, y / wavelength, seed);
      data[y * width + x] = n * amplitude;
    }
  }
  return data;
}
