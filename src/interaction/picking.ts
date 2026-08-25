import { worldToAxial } from '../hex/coords';
import { sampleHeightField } from '../terrain/sample';
import type { Ray } from '../camera/orbitCamera';
import type { Vec3 } from '../math/mat4';

export interface PickResult {
  q: number;
  r: number;
  point: Vec3;
}

// Ray-marches the CPU-side height field (not the GPU mesh — the terrain
// data already lives in JS as a flat array, and a heightfield ray march is
// simpler and plenty accurate for touch picking; no need for a mesh BVH).
// Coarse fixed steps, refined by bisection once the ray crosses the surface.
export function pickTerrain(
  ray: Ray,
  surfaceHeight: Float32Array,
  fieldCols: number,
  fieldRows: number,
  hexSize: number,
  maxDistance: number
): PickResult | null {
  const heightAt = (x: number, z: number) => sampleHeightField(x, z, surfaceHeight, fieldCols, fieldRows, hexSize);

  const step = hexSize * 4;
  let prevT = 0;

  for (let t = step; t <= maxDistance; t += step) {
    const x = ray.origin[0] + ray.direction[0] * t;
    const y = ray.origin[1] + ray.direction[1] * t;
    const z = ray.origin[2] + ray.direction[2] * t;
    const terrainY = heightAt(x, z);

    if (terrainY !== null && y <= terrainY) {
      // Crossed the surface somewhere in (prevT, t] — refine by bisection.
      let lo = prevT;
      let hi = t;
      for (let i = 0; i < 10; i++) {
        const mid = (lo + hi) / 2;
        const mx = ray.origin[0] + ray.direction[0] * mid;
        const my = ray.origin[1] + ray.direction[1] * mid;
        const mz = ray.origin[2] + ray.direction[2] * mid;
        const mh = heightAt(mx, mz);
        if (mh !== null && my <= mh) hi = mid;
        else lo = mid;
      }
      const hx = ray.origin[0] + ray.direction[0] * hi;
      const hy = ray.origin[1] + ray.direction[1] * hi;
      const hz = ray.origin[2] + ray.direction[2] * hi;
      const { q, r } = worldToAxial(hx, hz, hexSize);
      return { q, r, point: [hx, hy, hz] };
    }

    prevT = t;
  }

  return null; // no hit within range — looking at the sky, or past the field edge
}
