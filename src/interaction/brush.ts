import { axialToWorld, AXIAL_DIRECTIONS, storageCol } from '../hex/coords';

export type ToolId = 'raise' | 'lower' | 'level' | 'fillToLevel' | 'smooth' | 'ruggedize';
export type MaterialId = 'sand' | 'earth' | 'rock';

export interface ToolDef {
  id: ToolId;
  label: string;
  /** Whether this tool deposits the currently-selected material (vs. being material-agnostic). */
  usesMaterial: boolean;
  /** Whether the first tap of a stroke establishes a reference height that subsequent strokes work toward. */
  usesLevelReference: boolean;
  /**
   * Whether each cell can only be affected once per stroke, no matter how
   * many pointer events land on it (holding still, or tracing back over the
   * same spot). Raise/Lower/Level/Fill-to-Level want the opposite — holding
   * longer builds up more effect, which is exactly the expected feel for a
   * deposit/sculpt brush. Smooth/Ruggedize need this because they react to
   * *neighbouring* cells rather than depositing a fixed amount: repeated
   * application compounds, and for Ruggedize (a divergent operator by
   * definition — it pushes values away from their neighbours) that compounds
   * geometrically with no natural stopping point.
   */
  oncePerCellPerStroke: boolean;
}

// Registry, not a switch statement — adding a tool later means appending an
// entry here (plus a case in applyToolAtCell), not touching the UI code.
export const TOOLS: readonly ToolDef[] = [
  { id: 'raise', label: 'Raise', usesMaterial: true, usesLevelReference: false, oncePerCellPerStroke: false },
  { id: 'lower', label: 'Lower', usesMaterial: false, usesLevelReference: false, oncePerCellPerStroke: false },
  { id: 'level', label: 'Level', usesMaterial: true, usesLevelReference: true, oncePerCellPerStroke: false },
  { id: 'fillToLevel', label: 'Fill to Level', usesMaterial: true, usesLevelReference: true, oncePerCellPerStroke: false },
  { id: 'smooth', label: 'Smooth', usesMaterial: false, usesLevelReference: false, oncePerCellPerStroke: true },
  { id: 'ruggedize', label: 'Ruggedize', usesMaterial: false, usesLevelReference: false, oncePerCellPerStroke: true },
];

export interface MaterialDef {
  id: MaterialId;
  label: string;
}

export const MATERIALS: readonly MaterialDef[] = [
  { id: 'sand', label: 'Sand' },
  { id: 'earth', label: 'Earth' },
  { id: 'rock', label: 'Rock' },
];

export interface BrushOptions {
  /** World-unit radius of effect. */
  radius: number;
  /** World-unit height change at the brush centre, per application. */
  strength: number;
  /**
   * Raise/Lower/Level/Fill-to-Level only: 0 = gradual conical ramp
   * (transition spans the whole radius), 1 = flat plateau with a steep edge
   * (transition confined to the outer rim). Smooth/Ruggedize ignore this and
   * always use a plain smoothstep.
   */
  steepness: number;
  material: MaterialId;
  /** Required for Level/Fill-to-Level — the height established by the stroke's first tap. */
  levelReference?: number;
  /** Required for Smooth/Ruggedize — cell indices already touched this stroke, mutated as new ones are visited. Owned by the caller so it persists across repeated applyBrush calls during one stroke. */
  touchedCellsThisStroke?: Set<number>;
}

export interface MaterialArrays {
  rock: Float32Array;
  earth: Float32Array;
  sand: Float32Array;
}

export interface BoundingBox {
  colMin: number;
  colMax: number;
  rowMin: number;
  rowMax: number;
}

function combinedHeight(m: MaterialArrays, idx: number): number {
  return m.rock[idx]! + m.earth[idx]! + m.sand[idx]!;
}

function depositMaterial(m: MaterialArrays, material: MaterialId, idx: number, amount: number): void {
  m[material][idx]! += amount;
}

// Shrinks the soil layer (sand+earth) keeping their current ratio intact —
// scaling the existing mix down rather than draining sand completely before
// touching earth at all. Once soil is fully exhausted, further lowering
// cuts into rock itself (unavoidable — a finite soil layer only goes so
// deep), which is what keeps a rocky ridge notchable rather than
// permanently un-lowerable.
function removeNatural(m: MaterialArrays, idx: number, amount: number): void {
  const sand = m.sand[idx]!;
  const earth = m.earth[idx]!;
  const soilDepth = sand + earth;

  let remaining = amount;
  if (soilDepth > 0) {
    const soilTake = Math.min(soilDepth, remaining);
    m.sand[idx]! -= soilTake * (sand / soilDepth);
    m.earth[idx]! -= soilTake * (earth / soilDepth);
    remaining -= soilTake;
  }
  if (remaining > 0) {
    m.rock[idx]! -= remaining;
  }
}

// True hex-neighbour average (reuses the tested axial helpers rather than a
// naive rectangular one — see D12, docs/design/02-decisions.md, for why
// that specific shortcut has bitten this codebase three times already).
function neighborAverageHeight(m: MaterialArrays, col: number, row: number, fieldCols: number, fieldRows: number): number {
  const q = col - Math.floor(row / 2);
  let sum = 0;
  let count = 0;
  for (const dir of AXIAL_DIRECTIONS) {
    const nq = q + dir.q;
    const nr = row + dir.r;
    if (nr < 0 || nr >= fieldRows) continue;
    const ncol = storageCol({ q: nq, r: nr });
    if (ncol < 0 || ncol >= fieldCols) continue;
    sum += combinedHeight(m, nr * fieldCols + ncol);
    count++;
  }
  return count > 0 ? sum / count : combinedHeight(m, row * fieldCols + col);
}

// Raise/Lower/Level/Fill-to-Level only ever look at the cell's own value —
// safe to mutate in place, one cell at a time, in a single pass.
function applyToolAtCell(
  tool: 'raise' | 'lower' | 'level' | 'fillToLevel',
  m: MaterialArrays,
  idx: number,
  material: MaterialId,
  budget: number, // world-unit height-change budget for this application (strength * falloff)
  levelReference: number | undefined
): void {
  switch (tool) {
    case 'raise':
      depositMaterial(m, material, idx, budget);
      break;
    case 'lower':
      removeNatural(m, idx, budget);
      break;
    case 'level': {
      const diff = levelReference! - combinedHeight(m, idx); // + needs raising, - needs lowering
      const amount = Math.sign(diff) * Math.min(Math.abs(diff), budget);
      if (amount > 0) depositMaterial(m, material, idx, amount);
      else if (amount < 0) removeNatural(m, idx, -amount);
      break;
    }
    case 'fillToLevel': {
      const diff = levelReference! - combinedHeight(m, idx);
      if (diff > 0) depositMaterial(m, material, idx, Math.min(diff, budget));
      break;
    }
  }
}

// Iterates a storage-space bounding box around the target cell (padded
// generously for the hex offset) rather than walking true hex rings, using
// actual world distance for the falloff — simple, and correct regardless of
// the row-parity storage quirks that have bitten this codebase before.
export function applyBrush(
  tool: ToolId,
  centerQ: number,
  centerR: number,
  materials: MaterialArrays,
  fieldCols: number,
  fieldRows: number,
  hexSize: number,
  worldStepX: number,
  worldStepZ: number,
  opts: BrushOptions
): BoundingBox {
  const center = axialToWorld({ q: centerQ, r: centerR }, hexSize);
  const colPad = Math.ceil(opts.radius / worldStepX) + 2;
  const rowPad = Math.ceil(opts.radius / worldStepZ) + 2;
  const centerCol = centerQ + Math.floor(centerR / 2);

  const colMin = Math.max(0, centerCol - colPad);
  const colMax = Math.min(fieldCols - 1, centerCol + colPad);
  const rowMin = Math.max(0, centerR - rowPad);
  const rowMax = Math.min(fieldRows - 1, centerR + rowPad);

  if (tool === 'smooth' || tool === 'ruggedize') {
    // Two-pass: Smooth/Ruggedize read each cell's *neighbours*, so mutating
    // in place while iterating would let an already-modified cell feed into
    // the next cell's average within the same application. Compute every
    // delta from the untouched state first, then apply them all at once.
    //
    // Each cell is also skipped if it's already in touchedCellsThisStroke —
    // Ruggedize amplifies deviation from the neighbour average, a divergent
    // operator by definition, so applying it repeatedly to the same cell
    // (holding still, or tracing back over the same spot both fire many
    // pointer events) compounds without limit. Restricting each cell to one
    // application per stroke removes the repetition entirely, which is what
    // actually makes the effect size predictable and controllable via the
    // Intensity slider — a per-application ceiling could only cap the
    // damage, not make the tool tunable.
    const indices: number[] = [];
    const deltas: number[] = [];
    for (let row = rowMin; row <= rowMax; row++) {
      for (let col = colMin; col <= colMax; col++) {
        const q = col - Math.floor(row / 2);
        const { x, y } = axialToWorld({ q, r: row }, hexSize);
        const dist = Math.hypot(x - center.x, y - center.y);
        if (dist > opts.radius) continue;

        const idx = row * fieldCols + col;
        if (opts.touchedCellsThisStroke?.has(idx)) continue;

        const budget = opts.strength * brushFalloff(dist, opts.radius, 0);
        const h = combinedHeight(materials, idx);
        const avg = neighborAverageHeight(materials, col, row, fieldCols, fieldRows);
        const delta = tool === 'smooth' ? (avg - h) * Math.min(budget, 1) : (h - avg) * budget;

        indices.push(idx);
        deltas.push(delta);
        opts.touchedCellsThisStroke?.add(idx);
      }
    }
    for (let i = 0; i < indices.length; i++) {
      materials.rock[indices[i]!]! += deltas[i]!; // reshapes the base terrain only — soil depth is untouched
    }
  } else {
    for (let row = rowMin; row <= rowMax; row++) {
      for (let col = colMin; col <= colMax; col++) {
        const q = col - Math.floor(row / 2);
        const { x, y } = axialToWorld({ q, r: row }, hexSize);
        const dist = Math.hypot(x - center.x, y - center.y);
        if (dist > opts.radius) continue;

        const falloff = brushFalloff(dist, opts.radius, opts.steepness);
        applyToolAtCell(
          tool,
          materials,
          row * fieldCols + col,
          opts.material,
          opts.strength * falloff,
          opts.levelReference
        );
      }
    }
  }

  return { colMin, colMax, rowMin, rowMax };
}

function smoothstep01(t: number): number {
  const c = Math.min(Math.max(t, 0), 1);
  return c * c * (3 - 2 * c);
}

// steepness=0 reduces to a plain smoothstep cone; steepness>0 holds full
// strength out to an inner "plateau" radius, confining the soft transition
// to the outer rim — the difference between a gentle mound and a flat-topped
// plateau with a steep edge.
function brushFalloff(dist: number, radius: number, steepness: number): number {
  const innerRadius = radius * steepness * 0.9; // leave at least 10% of radius for the transition
  if (dist <= innerRadius) return 1;
  return 1 - smoothstep01((dist - innerRadius) / (radius - innerRadius));
}
