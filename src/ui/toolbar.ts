import { MATERIALS, TOOLS, type MaterialId, type ToolId } from '../interaction/brush';

export interface BrushSettings {
  /** World-unit radius of effect. */
  size: number;
  /** World-unit height change at the brush centre, per application. */
  intensity: number;
  /** 0 = gradual conical ramp, 1 = flat plateau with a steep edge. */
  steepness: number;
}

export interface ToolbarHandle {
  settings: BrushSettings;
  getActiveMaterial(): MaterialId;
  setUndoEnabled(enabled: boolean): void;
}

const SLIDER_SPECS: { key: keyof BrushSettings; label: string; min: number; max: number; step: number }[] = [
  { key: 'size', label: 'Size', min: 5, max: 150, step: 5 },
  { key: 'intensity', label: 'Intensity', min: 0.05, max: 2, step: 0.05 },
  { key: 'steepness', label: 'Steepness', min: 0, max: 1, step: 0.05 },
];

// Three sections — Materials, Tool, Brush — each built by iterating a data
// array (MATERIALS/TOOLS registries, SLIDER_SPECS) rather than one-off
// per-item UI code, so adding or reordering an entry in those arrays is all
// it takes to change what shows up here.
export function createToolbar(onToolChange: (tool: ToolId | null) => void, onUndo: () => void): ToolbarHandle {
  const settings: BrushSettings = { size: 40, intensity: 0.3, steepness: 0.3 };
  let activeMaterial: MaterialId = 'earth';
  let activeTool: ToolId | null = null;

  const root = document.createElement('div');
  root.style.cssText = `
    position: fixed; bottom: 0; left: 0; z-index: 999998;
    font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
    color: #eee; background: rgba(20,20,24,0.8);
    padding: 8px; max-width: 240px;
    -webkit-user-select: none; user-select: none;
    border-top-right-radius: 8px;
  `;
  document.body.appendChild(root);

  // Collapse toggle — visually mirrors the Terrain panel (src/ui/controls.ts).
  // Behaviourally it's more than a hide: an active brush tool means touch is
  // capturing paint strokes instead of driving the camera, so collapsing the
  // panel fully unequips the tool (see the handler further down), rather than
  // leaving it armed underneath a hidden UI.
  const toggleBar = document.createElement('div');
  toggleBar.textContent = 'Tools ▼';
  toggleBar.style.cssText = 'cursor: pointer; font-weight: bold; margin-bottom: 6px;';
  root.appendChild(toggleBar);

  const body = document.createElement('div');
  root.appendChild(body);

  function addSectionLabel(text: string): void {
    const label = document.createElement('div');
    label.textContent = text;
    label.style.cssText = 'opacity: 0.6; margin: 6px 0 2px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em;';
    body.appendChild(label);
  }

  function addButtonRow<T extends string>(
    entries: readonly { id: T; label: string }[],
    getActive: () => T | null,
    setActive: (id: T) => void
  ): { buttons: Map<T, HTMLButtonElement>; refresh: () => void } {
    const row = document.createElement('div');
    row.style.cssText = 'display: flex; gap: 6px; flex-wrap: wrap;';
    body.appendChild(row);

    const buttons = new Map<T, HTMLButtonElement>();
    function refresh(): void {
      const active = getActive();
      for (const [id, btn] of buttons) {
        btn.style.background = id === active ? 'rgba(120,180,255,0.5)' : 'rgba(255,255,255,0.12)';
      }
    }

    for (const entry of entries) {
      const btn = document.createElement('button');
      btn.textContent = entry.label;
      btn.style.cssText = `
        padding: 8px 10px; font: inherit; color: inherit;
        background: rgba(255,255,255,0.12); border: 1px solid rgba(255,255,255,0.25);
        border-radius: 4px; touch-action: manipulation;
      `;
      btn.addEventListener('pointerup', () => {
        setActive(entry.id);
        refresh();
      });
      buttons.set(entry.id, btn);
      row.appendChild(btn);
    }
    refresh();
    return { buttons, refresh };
  }

  // A meta-action, not a tool/material selection — its own row, enabled
  // state driven externally by main.ts (which owns the undo stack, since it
  // needs the full generation pipeline to restore a snapshot).
  const undoBtn = document.createElement('button');
  undoBtn.textContent = 'Undo';
  undoBtn.style.cssText = `
    display: block; width: 100%; margin-bottom: 8px; padding: 8px 10px;
    font: inherit; color: inherit; background: rgba(255,255,255,0.12);
    border: 1px solid rgba(255,255,255,0.25); border-radius: 4px;
    touch-action: manipulation; opacity: 0.4;
  `;
  undoBtn.disabled = true;
  undoBtn.addEventListener('pointerup', () => {
    if (!undoBtn.disabled) onUndo();
  });
  body.appendChild(undoBtn);

  addSectionLabel('Materials');
  addButtonRow(
    MATERIALS,
    () => activeMaterial,
    (id) => {
      activeMaterial = id;
    }
  );

  addSectionLabel('Tool');
  const toolRow = addButtonRow(
    TOOLS,
    () => activeTool,
    (id) => {
      // Tapping the active tool again deselects it — no separate "Navigate"
      // entry needed, deselecting everything already means navigate.
      activeTool = activeTool === id ? null : id;
      onToolChange(activeTool);
    }
  );

  addSectionLabel('Brush');
  for (const spec of SLIDER_SPECS) {
    const row = document.createElement('div');
    row.style.cssText = 'display: flex; align-items: center; gap: 6px; margin: 4px 0;';

    const label = document.createElement('label');
    label.textContent = spec.label;
    label.style.cssText = 'flex: 0 0 60px;';

    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.step = String(spec.step);
    input.value = String(settings[spec.key]);
    input.style.cssText = 'flex: 1 1 auto; touch-action: pan-x;';

    const valueLabel = document.createElement('span');
    valueLabel.textContent = formatValue(settings[spec.key]);
    valueLabel.style.cssText = 'flex: 0 0 34px; text-align: right;';

    input.addEventListener('input', () => {
      settings[spec.key] = Number(input.value);
      valueLabel.textContent = formatValue(settings[spec.key]);
    });

    row.appendChild(label);
    row.appendChild(input);
    row.appendChild(valueLabel);
    body.appendChild(row);
  }

  let collapsed = false;
  toggleBar.addEventListener('pointerup', () => {
    collapsed = !collapsed;
    body.style.display = collapsed ? 'none' : 'block';
    toggleBar.textContent = collapsed ? 'Tools ▲' : 'Tools ▼';
    // Collapsing unequips the active tool outright — the same path as tapping
    // its button again: onToolChange(null) is what hands touch back to the
    // camera, clears cursorPoint, and resets Fill to Level's sampled
    // reference over in main.ts. toolRow.refresh() drops the button highlight
    // so the panel reflects the unequipped state when it's expanded again.
    if (collapsed && activeTool !== null) {
      activeTool = null;
      onToolChange(null);
      toolRow.refresh();
    }
  });

  return {
    settings,
    getActiveMaterial: () => activeMaterial,
    setUndoEnabled(enabled: boolean) {
      undoBtn.disabled = !enabled;
      undoBtn.style.opacity = enabled ? '1' : '0.4';
    },
  };
}

function formatValue(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}
