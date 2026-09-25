import { DEFAULT_EROSION_SETTINGS, type ErosionSettings } from '../sim/erosionSim';

// M4 dev tuning panel (docs/design/06-m4-brief.md §1, §5.6): live erosion
// constants against the running sim, plus the D22 toggle and the dev
// fast-forward. A *dev* surface — player-facing erosion controls are designed
// after the sim is proven (brief §2). Styled to match the Terrain panel.

type NumericKey = Exclude<keyof ErosionSettings, 'hydraulic' | 'slumping'>;

interface SliderSpec {
  key: NumericKey;
  label: string;
  min: number;
  max: number;
  /** Log-scaled: these constants span orders of magnitude, and the interesting range is near the bottom. */
  log: boolean;
}

const SLIDERS: SliderSpec[] = [
  { key: 'capacity', label: 'Capacity', min: 0.001, max: 1, log: true },
  { key: 'erodeSand', label: 'Sand pickup', min: 0.01, max: 10, log: true },
  { key: 'erodeEarth', label: 'Earth pickup', min: 0.001, max: 5, log: true },
  { key: 'deposit', label: 'Deposit', min: 0.01, max: 10, log: true },
  { key: 'minTilt', label: 'Min tilt', min: 0, max: 0.2, log: false },
  { key: 'fullDepth', label: 'Full depth', min: 0.005, max: 2, log: true },
  { key: 'talusSandDeg', label: 'Sand angle°', min: 10, max: 60, log: false },
  { key: 'talusEarthDeg', label: 'Earth angle°', min: 10, max: 80, log: false },
  // Kt · (4 ticks / 30 Hz) is capped at 1 in the sim, so ~7.5 is the fastest meaningful rate.
  { key: 'slumpRate', label: 'Slump rate', min: 0.05, max: 7.5, log: true },
];

const SPEEDS = [1, 2, 4, 8] as const;
const STEPS = 200; // slider resolution

export interface DevPanelCallbacks {
  onSpeed(speed: number): void;
  onRain(enabled: boolean): void;
}

export function createDevPanel(settings: ErosionSettings, initialRain: boolean, callbacks: DevPanelCallbacks): void {
  const root = document.createElement('div');
  root.style.cssText = `
    position: fixed; top: 0; right: 0; z-index: 999998;
    font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
    color: #eee; background: rgba(20,20,24,0.8);
    padding: 10px 12px; max-width: 280px;
    -webkit-user-select: none; user-select: none;
    border-bottom-left-radius: 8px;
  `;
  document.body.appendChild(root);

  const toggleBar = document.createElement('div');
  toggleBar.style.cssText = 'cursor: pointer; font-weight: bold; margin-bottom: 6px;';
  root.appendChild(toggleBar);
  const body = document.createElement('div');
  root.appendChild(body);

  // Starts collapsed — it's a dev surface and it covers the top-right of the map.
  let collapsed = true;
  function renderCollapsed(): void {
    body.style.display = collapsed ? 'none' : 'block';
    toggleBar.textContent = collapsed ? 'Erosion (dev) ▼' : 'Erosion (dev) ▲';
  }
  renderCollapsed();
  toggleBar.addEventListener('pointerup', () => {
    collapsed = !collapsed;
    renderCollapsed();
  });

  const buttonStyle = (active: boolean) => `
    flex: 1; padding: 6px 4px; font: inherit; color: inherit;
    background: ${active ? 'rgba(120,180,255,0.5)' : 'rgba(255,255,255,0.12)'};
    border: 1px solid rgba(255,255,255,0.25); border-radius: 4px;
  `;

  function addRow(label: string): HTMLDivElement {
    const row = document.createElement('div');
    row.style.cssText = 'display: flex; align-items: center; gap: 6px; margin: 4px 0;';
    const l = document.createElement('span');
    l.textContent = label;
    l.style.cssText = 'flex: 0 0 90px;';
    row.appendChild(l);
    body.appendChild(row);
    return row;
  }

  function addToggle(label: string, initial: boolean, onChange: (on: boolean) => void): void {
    const row = addRow(label);
    let on = initial;
    const btn = document.createElement('button');
    const render = () => {
      btn.textContent = on ? 'On' : 'Off';
      btn.style.cssText = buttonStyle(on);
    };
    render();
    btn.addEventListener('pointerup', () => {
      on = !on;
      render();
      onChange(on);
    });
    row.appendChild(btn);
  }

  addToggle('Hydraulic', settings.hydraulic, (on) => {
    settings.hydraulic = on;
  });
  addToggle('Slumping', settings.slumping, (on) => {
    settings.slumping = on;
  });
  addToggle('Rain', initialRain, (on) => callbacks.onRain(on));

  // Fast-forward (brief §1): more sim ticks per frame, not bigger steps.
  const speedRow = addRow('Speed');
  let speed = 1;
  const speedButtons: HTMLButtonElement[] = [];
  for (const sp of SPEEDS) {
    const btn = document.createElement('button');
    btn.textContent = `${sp}×`;
    btn.addEventListener('pointerup', () => {
      speed = sp;
      speedButtons.forEach((b, k) => (b.style.cssText = buttonStyle(SPEEDS[k] === speed)));
      callbacks.onSpeed(sp);
    });
    btn.style.cssText = buttonStyle(sp === speed);
    speedButtons.push(btn);
    speedRow.appendChild(btn);
  }

  const toSlider = (spec: SliderSpec, v: number) =>
    spec.log
      ? (Math.log(v / spec.min) / Math.log(spec.max / spec.min)) * STEPS
      : ((v - spec.min) / (spec.max - spec.min)) * STEPS;
  const fromSlider = (spec: SliderSpec, t: number) =>
    spec.log ? spec.min * Math.pow(spec.max / spec.min, t / STEPS) : spec.min + ((spec.max - spec.min) * t) / STEPS;

  const syncers: (() => void)[] = [];
  for (const spec of SLIDERS) {
    const row = addRow(spec.label);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = '0';
    input.max = String(STEPS);
    input.step = '1';
    input.style.cssText = 'flex: 1 1 auto; touch-action: pan-x;';
    const value = document.createElement('span');
    value.style.cssText = 'flex: 0 0 44px; text-align: right;';
    const sync = () => {
      input.value = String(Math.round(toSlider(spec, settings[spec.key])));
      value.textContent = formatValue(settings[spec.key]);
    };
    sync();
    syncers.push(sync);
    // Constants are cheap uniforms — apply live on every drag event, no need
    // to wait for release like the terrain regenerate sliders do.
    input.addEventListener('input', () => {
      settings[spec.key] = fromSlider(spec, Number(input.value));
      value.textContent = formatValue(settings[spec.key]);
    });
    row.appendChild(input);
    row.appendChild(value);
  }

  const resetRow = document.createElement('div');
  resetRow.style.cssText = 'display: flex; gap: 6px; margin-top: 8px;';
  const reset = document.createElement('button');
  reset.textContent = 'Default constants';
  reset.style.cssText = buttonStyle(false);
  reset.addEventListener('pointerup', () => {
    for (const spec of SLIDERS) settings[spec.key] = DEFAULT_EROSION_SETTINGS[spec.key];
    syncers.forEach((s) => s());
  });
  resetRow.appendChild(reset);
  body.appendChild(resetRow);
}

function formatValue(v: number): string {
  if (v === 0) return '0';
  if (v >= 10) return v.toFixed(1);
  if (v >= 1) return v.toFixed(2);
  return v.toPrecision(2);
}
