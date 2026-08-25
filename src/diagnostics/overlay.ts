// On-screen diagnostics HUD. This is the debugging story for this project:
// there is no Mac, so no Safari Web Inspector on iPad. Whatever isn't visible
// here didn't happen.

const MAX_LOG_LINES = 40;

export class DiagnosticsOverlay {
  private root: HTMLDivElement;
  private statsEl: HTMLDivElement;
  private deviceEl: HTMLDivElement;
  private logEl: HTMLDivElement;
  private fatalEl: HTMLDivElement;

  private frameTimes: number[] = [];
  private lastFrameAt = performance.now();

  constructor() {
    this.root = document.createElement('div');
    this.root.style.cssText = `
      position: fixed; top: 0; left: 0; z-index: 999999;
      font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
      color: #0f0; background: rgba(0,0,0,0.55);
      padding: 6px 8px; max-width: 46vw; max-height: 40vh;
      overflow-y: auto; pointer-events: none; white-space: pre-wrap;
      -webkit-user-select: none; user-select: none;
    `;

    this.statsEl = document.createElement('div');
    this.deviceEl = document.createElement('div');
    this.deviceEl.style.cssText = 'color: #6cf; margin-top: 4px;';
    this.logEl = document.createElement('div');
    this.logEl.style.cssText = 'color: #f66; margin-top: 4px;';

    this.root.appendChild(this.statsEl);
    this.root.appendChild(this.deviceEl);
    this.root.appendChild(this.logEl);
    document.body.appendChild(this.root);

    // Full-screen blocking banner for errors severe enough that the small
    // log corner isn't enough — e.g. WebGPU unsupported. Hidden by default.
    this.fatalEl = document.createElement('div');
    this.fatalEl.style.cssText = `
      display: none; position: fixed; inset: 0; z-index: 9999999;
      background: #300; color: #fff; font: 16px/1.5 ui-monospace, monospace;
      padding: 24px; box-sizing: border-box; white-space: pre-wrap;
    `;
    document.body.appendChild(this.fatalEl);

    window.addEventListener('error', (e) => {
      this.logError(`window.onerror: ${e.message} (${e.filename}:${e.lineno})`);
    });
    window.addEventListener('unhandledrejection', (e) => {
      this.logError(`unhandled rejection: ${String(e.reason)}`);
    });
  }

  setDeviceInfo(lines: string[]): void {
    this.deviceEl.textContent = lines.join('\n');
  }

  recordFrame(): void {
    const now = performance.now();
    const dt = now - this.lastFrameAt;
    this.lastFrameAt = now;
    this.frameTimes.push(dt);
    if (this.frameTimes.length > 30) this.frameTimes.shift();

    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    const fps = 1000 / avg;
    this.statsEl.textContent = `${fps.toFixed(0)} fps  |  ${avg.toFixed(2)} ms/frame`;
  }

  logError(message: string): void {
    const line = document.createElement('div');
    line.textContent = `[${new Date().toISOString().slice(11, 19)}] ${message}`;
    this.logEl.appendChild(line);
    while (this.logEl.childNodes.length > MAX_LOG_LINES) {
      this.logEl.removeChild(this.logEl.firstChild as ChildNode);
    }
    console.error(message);
  }

  showFatal(message: string): void {
    this.fatalEl.textContent = message;
    this.fatalEl.style.display = 'block';
    this.logError(`FATAL: ${message}`);
  }
}
