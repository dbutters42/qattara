import type { MaterialArrays } from './brush';

export interface UndoStack<T extends MaterialArrays = MaterialArrays> {
  push(snapshot: T): void;
  /** Pops and returns the most recent snapshot, or null if there's nothing to undo. */
  undo(): T | null;
  clear(): void;
  canUndo(): boolean;
}

// Scoped to brush strokes only, not terrain regeneration (New Seed/Random/
// Flat/sliders) — those already have their own reset path, and correctly
// undoing one would mean also tracking the generator parameters that were
// in effect beforehand, not just the resulting material arrays. Regenerating
// clears this stack (see main.ts) since old snapshots belong to a terrain
// that no longer exists.
export function createUndoStack<T extends MaterialArrays = MaterialArrays>(maxDepth: number): UndoStack<T> {
  const stack: T[] = [];
  return {
    push(snapshot) {
      stack.push(snapshot);
      if (stack.length > maxDepth) stack.shift();
    },
    undo() {
      return stack.pop() ?? null;
    },
    clear() {
      stack.length = 0;
    },
    canUndo() {
      return stack.length > 0;
    },
  };
}
