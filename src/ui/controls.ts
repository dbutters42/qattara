import type { TerrainGenParams } from '../terrain/generator';

export interface SliderSpec {
  key: 'ruggedness' | 'depthRange' | 'elevationRange' | 'rockiness' | 'sandBand' | 'waterLevel';
  label: string;
  min: number;
  max: number;
  step: number;
}

const SLIDERS: SliderSpec[] = [
  { key: 'ruggedness', label: 'Ruggedness', min: 0, max: 1, step: 0.05 },
  { key: 'depthRange', label: 'Depth range', min: 5, max: 100, step: 5 },
  { key: 'elevationRange', label: 'Elevation range', min: 5, max: 100, step: 5 },
  { key: 'rockiness', label: 'Rockiness', min: 0, max: 1, step: 0.05 },
  { key: 'sandBand', label: 'Sand reach', min: 0, max: 40, step: 2 },
  { key: 'waterLevel', label: 'Water level', min: -150, max: 150, step: 5 },
];

// Regeneration re-evaluates noise over the whole field (~1M cells, several
// noise calls each) — cheap enough on release, too slow for every pixel of
// drag. Range inputs fire 'input' continuously but only 'change' once the
// user lets go, so live label updates use the former and regeneration the
// latter.
export function createControlPanel(
  initialParams: TerrainGenParams,
  onRegenerate: (params: TerrainGenParams) => void
): void {
  const params = { ...initialParams };

  const root = document.createElement('div');
  root.style.cssText = `
    position: fixed; bottom: 0; right: 0; z-index: 999998;
    font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
    color: #eee; background: rgba(20,20,24,0.8);
    padding: 10px 12px; max-width: 280px;
    -webkit-user-select: none; user-select: none;
    border-top-left-radius: 8px;
  `;
  document.body.appendChild(root);

  const toggleBar = document.createElement('div');
  toggleBar.textContent = 'Terrain ▼';
  toggleBar.style.cssText = 'cursor: pointer; font-weight: bold; margin-bottom: 6px;';
  root.appendChild(toggleBar);

  const body = document.createElement('div');
  root.appendChild(body);

  let collapsed = false;
  toggleBar.addEventListener('pointerup', () => {
    collapsed = !collapsed;
    body.style.display = collapsed ? 'none' : 'block';
    toggleBar.textContent = collapsed ? 'Terrain ▲' : 'Terrain ▼';
  });

  const valueLabels = new Map<string, HTMLSpanElement>();

  for (const spec of SLIDERS) {
    const row = document.createElement('div');
    row.style.cssText = 'display: flex; align-items: center; gap: 6px; margin: 4px 0;';

    const label = document.createElement('label');
    label.textContent = spec.label;
    label.style.cssText = 'flex: 0 0 90px;';

    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.step = String(spec.step);
    input.value = String(params[spec.key]);
    input.style.cssText = 'flex: 1 1 auto; touch-action: pan-x;';

    const valueLabel = document.createElement('span');
    valueLabel.textContent = formatValue(params[spec.key]);
    valueLabel.style.cssText = 'flex: 0 0 34px; text-align: right;';
    valueLabels.set(spec.key, valueLabel);

    input.addEventListener('input', () => {
      valueLabel.textContent = formatValue(Number(input.value));
    });
    input.addEventListener('change', () => {
      params[spec.key] = Number(input.value);
      onRegenerate({ ...params });
    });

    row.appendChild(label);
    row.appendChild(input);
    row.appendChild(valueLabel);
    body.appendChild(row);
  }

  function syncSliders(): void {
    for (const spec of SLIDERS) {
      const input = body.querySelectorAll('input')[SLIDERS.indexOf(spec)] as HTMLInputElement;
      input.value = String(params[spec.key]);
      valueLabels.get(spec.key)!.textContent = formatValue(params[spec.key]);
    }
  }

  const buttonRow = document.createElement('div');
  buttonRow.style.cssText = 'display: flex; gap: 6px; margin-top: 8px;';
  body.appendChild(buttonRow);

  function addButton(text: string, onTap: () => void): void {
    const btn = document.createElement('button');
    btn.textContent = text;
    btn.style.cssText = `
      flex: 1; padding: 6px 4px; font: inherit; color: inherit;
      background: rgba(255,255,255,0.12); border: 1px solid rgba(255,255,255,0.25);
      border-radius: 4px;
    `;
    btn.addEventListener('pointerup', onTap);
    buttonRow.appendChild(btn);
  }

  addButton('New seed', () => {
    params.seed = Math.floor(Math.random() * 1e9);
    onRegenerate({ ...params });
  });

  addButton('Random', () => {
    params.seed = Math.floor(Math.random() * 1e9);
    params.ruggedness = Math.random();
    params.depthRange = 20 + Math.random() * 70;
    params.elevationRange = 20 + Math.random() * 70;
    params.rockiness = Math.random();
    params.sandBand = Math.random() * 30;
    params.waterLevel = -90 + Math.random() * 180;
    syncSliders();
    onRegenerate({ ...params });
  });

  addButton('Flat', () => {
    params.ruggedness = 0;
    params.depthRange = 5;
    params.elevationRange = 5;
    params.rockiness = 0;
    params.sandBand = 0;
    params.waterLevel = -1000; // low enough that nothing floods regardless of range
    syncSliders();
    onRegenerate({ ...params });
  });
}

function formatValue(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}
