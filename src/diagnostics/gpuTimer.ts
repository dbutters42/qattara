// Per-pass GPU timings for the HUD (docs/design/06-m4-brief.md §5.5). M4 is
// the honest "is a webview fast enough" test; without real per-pass numbers
// every "go native / go half-res?" conversation is an argument.
//
// Uses WebGPU `timestamp-query` when the device has it: each timed compute
// pass writes a begin/end timestamp, resolved and read back only on sampled
// ticks (about once a second), so the hot path pays nothing otherwise. If the
// feature is missing, falls back to whole-submit timing — wall time from
// submit to onSubmittedWorkDone — which includes queue wait but still bounds
// the cost.

const MAX_PASSES = 8;

export interface GpuTimer {
  /** Whether per-pass timestamps are available (vs. the whole-submit fallback). */
  readonly perPass: boolean;
  /** Call once per tick before encoding. `sample` = time this tick. */
  beginTick(sample: boolean): void;
  /** Compute-pass descriptor for a named pass — carries timestampWrites on sampled ticks. */
  pass(label: string): GPUComputePassDescriptor;
  /** Encode the query resolve + copy. Call after the last timed pass, before finish(). */
  resolve(encoder: GPUCommandEncoder): void;
  /** Call right after queue.submit(). */
  afterSubmit(): void;
  /** Latest sample as "label ms" pairs, or null if none yet. */
  latest(): { label: string; ms: number }[] | null;
}

export function createGpuTimer(device: GPUDevice): GpuTimer {
  const perPass = device.features.has('timestamp-query');

  let sampling = false;
  let busy = false; // a sample is in flight between encode and readback
  let labels: string[] = [];
  let result: { label: string; ms: number }[] | null = null;

  if (!perPass) {
    let submitAt = 0;
    return {
      perPass,
      beginTick(sample) {
        sampling = sample && !busy;
      },
      pass(label) {
        return { label };
      },
      resolve() {},
      afterSubmit() {
        if (!sampling) return;
        sampling = false;
        busy = true;
        submitAt = performance.now();
        device.queue
          .onSubmittedWorkDone()
          .then(() => {
            result = [{ label: 'tick (submit→done)', ms: performance.now() - submitAt }];
          })
          .finally(() => {
            busy = false;
          });
      },
      latest: () => result,
    };
  }

  const querySet = device.createQuerySet({ type: 'timestamp', count: MAX_PASSES * 2 });
  const resolveBuffer = device.createBuffer({
    size: MAX_PASSES * 2 * 8,
    usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
  });
  const readBuffer = device.createBuffer({
    size: MAX_PASSES * 2 * 8,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  let resolved = false;

  return {
    perPass,
    beginTick(sample) {
      sampling = sample && !busy;
      labels = [];
      resolved = false;
    },
    pass(label) {
      if (!sampling || labels.length >= MAX_PASSES) return { label };
      const k = labels.length;
      labels.push(label);
      return {
        label,
        timestampWrites: { querySet, beginningOfPassWriteIndex: k * 2, endOfPassWriteIndex: k * 2 + 1 },
      };
    },
    resolve(encoder) {
      if (!sampling || labels.length === 0) return;
      encoder.resolveQuerySet(querySet, 0, labels.length * 2, resolveBuffer, 0);
      encoder.copyBufferToBuffer(resolveBuffer, 0, readBuffer, 0, labels.length * 2 * 8);
      resolved = true;
    },
    afterSubmit() {
      if (!sampling) return;
      sampling = false;
      if (!resolved) return;
      busy = true;
      const taken = labels.slice();
      readBuffer
        .mapAsync(GPUMapMode.READ)
        .then(() => {
          const t = new BigInt64Array(readBuffer.getMappedRange());
          result = taken.map((label, k) => ({ label, ms: Number(t[k * 2 + 1]! - t[k * 2]!) / 1e6 }));
          readBuffer.unmap();
        })
        .catch(() => {
          /* device lost — drop this sample */
        })
        .finally(() => {
          busy = false;
        });
    },
    latest: () => result,
  };
}
