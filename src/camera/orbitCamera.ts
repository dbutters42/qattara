import { lookAt, multiply, perspective, type Mat4, type Vec3 } from '../math/mat4';

const MIN_PITCH = Math.PI / 12; // 15° — clamped away from horizontal; a grazing view is degenerate for a terrain map
const MAX_PITCH = (85 * Math.PI) / 180; // stops short of true top-down to avoid the orbit's pole singularity

export interface OrbitCameraOptions {
  minDistance: number;
  maxDistance: number;
  initialDistance: number;
  target?: Vec3;
}

// Gesture mapping follows the map-app convention (Google/Apple Maps 3D mode):
// one-finger drag pans, pinch zooms, two-finger rotate orbits (yaw),
// two-finger vertical drag tilts (pitch).
export class OrbitCamera {
  private target: Vec3;
  private distance: number;
  private yaw = 0;
  private pitch = Math.PI / 3;
  private readonly minDistance: number;
  private readonly maxDistance: number;

  private pointers = new Map<number, { x: number; y: number }>();
  private prevPinchDist: number | null = null;
  private prevPinchAngle: number | null = null;
  private prevMidpoint: { x: number; y: number } | null = null;

  constructor(canvas: HTMLCanvasElement, opts: OrbitCameraOptions) {
    this.target = opts.target ?? [0, 0, 0];
    this.distance = opts.initialDistance;
    this.minDistance = opts.minDistance;
    this.maxDistance = opts.maxDistance;

    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.prevPinchDist = null;
      this.prevPinchAngle = null;
      this.prevMidpoint = null;
    });
    canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    const release = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      this.prevPinchDist = null;
      this.prevPinchAngle = null;
      this.prevMidpoint = null;
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
  }

  private onPointerMove(e: PointerEvent): void {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const cur = { x: e.clientX, y: e.clientY };

    if (this.pointers.size === 1) {
      const dx = cur.x - prev.x;
      const dy = cur.y - prev.y;
      this.pan(dx, dy);
    } else if (this.pointers.size === 2) {
      this.pointers.set(e.pointerId, cur);
      const pts = [...this.pointers.values()];
      const [p0, p1] = pts as [{ x: number; y: number }, { x: number; y: number }];
      const dist = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      const angle = Math.atan2(p1.y - p0.y, p1.x - p0.x);
      const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };

      if (this.prevPinchDist !== null) this.zoom(this.prevPinchDist / dist);
      if (this.prevPinchAngle !== null) this.orbit(angle - this.prevPinchAngle);
      if (this.prevMidpoint !== null) this.tilt(mid.y - this.prevMidpoint.y);

      this.prevPinchDist = dist;
      this.prevPinchAngle = angle;
      this.prevMidpoint = mid;
      return;
    }

    this.pointers.set(e.pointerId, cur);
  }

  private pan(dxPx: number, dyPx: number): void {
    // Scale with distance so a screen-pixel drag covers the same apparent
    // ground distance whether zoomed in or out.
    const speed = this.distance * 0.0015;
    const sinYaw = Math.sin(this.yaw);
    const cosYaw = Math.cos(this.yaw);
    // Right and forward vectors projected onto the ground plane (yaw only —
    // pitch doesn't affect pan direction, matching map-app behaviour).
    const rightX = cosYaw;
    const rightZ = -sinYaw;
    const fwdX = sinYaw;
    const fwdZ = cosYaw;

    this.target[0] -= (dxPx * rightX - dyPx * fwdX) * speed;
    this.target[2] -= (dxPx * rightZ - dyPx * fwdZ) * speed;
  }

  private zoom(ratio: number): void {
    this.distance = clamp(this.distance * ratio, this.minDistance, this.maxDistance);
  }

  private orbit(deltaRadians: number): void {
    this.yaw -= deltaRadians;
  }

  private tilt(deltaYPx: number): void {
    this.pitch = clamp(this.pitch + deltaYPx * 0.005, MIN_PITCH, MAX_PITCH);
  }

  viewProjection(aspect: number): Mat4 {
    const eye: Vec3 = [
      this.target[0] + this.distance * Math.cos(this.pitch) * Math.sin(this.yaw),
      this.target[1] + this.distance * Math.sin(this.pitch),
      this.target[2] + this.distance * Math.cos(this.pitch) * Math.cos(this.yaw),
    ];
    const view = lookAt(eye, this.target, [0, 1, 0]);
    // Near/far scaled to current zoom rather than fixed: a fixed near=1 with
    // far in the tens of thousands wastes nearly all depth-buffer precision
    // on a range the camera never actually uses at this distance.
    const near = clamp(this.distance * 0.02, 0.5, 50);
    const far = this.maxDistance * 2;
    const proj = perspective((60 * Math.PI) / 180, aspect, near, far);
    return multiply(proj, view);
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}
