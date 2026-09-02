# 05 — M3 BRIEF: WATER

**Status:** in progress (started 2026-09-02).
**Purpose:** the project's first real GPU simulation. Water that falls, flows downhill, pools in basins, and can be held back by terrain the player raises. Proves the virtual-pipes model works on hex, on-device, at full field resolution.

---

## 1. What M3 must do

- Rain falls (globally, at a constant rate for now) and/or enters at point springs.
- Water flows downhill through the hex pipe model, pools in closed basins, and finds a level.
- Evaporation removes water over time, so the world reaches a steady state instead of filling forever.
- A ridge raised with the brush **holds water back** — this is the headline demo for the milestone.
- The pipe model stays **numerically stable**: no negative depths, no runaway volume. Total water volume tracks its expected value (rain in − evaporation out) to float precision in a closed domain.

## 2. Explicitly NOT in M3

- **No erosion, no sediment, no thermal slumping.** Terrain height is fixed for the whole milestone. Water sits on top of an unchanging surface. (That is M4 — and M4 is where the parameter-tuning work lives.)
- **No player water controls.** Rain rate is a constant; one or two springs are hardcoded near the map centre. The real control surface (rain slider, spring brush, drain brush) is designed *after* the sim is working and stable on-device — same sequencing as M1's generator (D13).
- **No water shading work.** The existing `water.wgsl` depth ramp is left as-is. Fresnel, flow distortion from the velocity field, shoreline — all M5.
- **No save/load of the water state.** M6.

## 3. Success criteria

| Criterion | Target |
| --- | --- |
| Sustained frame rate on iPad with the sim running | 60 fps |
| Frame rate on iPhone | ≥ 30 fps |
| Sim resolution | Full 1024 × 1024 — same grid as the height field. Drop to half-res only if profiling forces it. |
| Tick rate | Fixed 30 Hz, decoupled from the render loop (outline §3) |
| Stability | Rain on + evaporation off + closed domain → volume grows linearly, no cell goes negative, nothing explodes. Rain off + evaporation off → volume constant. |
| Damming | Raise a brush ridge across a channel with water flowing → water backs up behind it and pools |

If the frame-rate numbers don't hold at full res, the fallback order is: half-res sim with bilinear upscale into the render sample → fewer passes per tick → lower tick rate. Reconsider the model only if all of those fail.

## 4. Architecture

### 4.1 The shift

Everything before M3 is **CPU-computed, GPU-rendered**: terrain is generated into `Float32Array`s, uploaded to `r32float` textures the shaders only ever `textureLoad`. M3 adds the first **compute** path and the first **GPU-authoritative** state.

- **Terrain stays CPU-authoritative.** The generator and the brush still own `rock`/`earth`/`sand` on the CPU and re-upload regions on edit. The sim only ever *reads* the terrain height texture. This keeps M2's editing untouched.
- **Water becomes GPU-authoritative.** After M3 there is no meaningful CPU copy of the water field. The generator's `floodFillWater` result is uploaded once as the sim's initial state; from then on the sim owns it. (Undo of a brush stroke no longer re-floods water — it already didn't do anything useful there, see D14 / main.ts.)

### 4.2 Per-cell sim state (GPU storage buffers)

| Field | Layout | Ping-pong? | Notes |
| --- | --- | --- | --- |
| `water` | `array<f32>`, W·H | **Yes** (A/B) | Standing/flowing depth. The only field that needs double-buffering. |
| `flux` | `array<f32>`, W·H·6 | No — in place | Outflow to each of the 6 hex neighbours. Updated reading only *heights*, never neighbour flux, so a cell can safely read+write its own 6 values in place. |
| `velocity` | `array<f32>`, W·H·2 | No — recomputed | Derived from flux each tick. Not used for rendering yet (M5) but it's nearly free to maintain and M4 needs it. |

Storage **buffers**, not textures: flux is 6 floats per cell and doesn't map onto texture channels. Buffers also keep the indexing arithmetic explicit, which suits an educational codebase.

### 4.3 Passes per tick

Fixed order, one command submit per tick:

1. **Input** — `water += rainRate · dt` everywhere (behind an on/off uniform); `water += springRate · dt` at hardcoded spring cells. In place on `water[A]`.
2. **Flux update** — for each of 6 neighbours: `f[i] = max(0, f[i] + dt · A · g · Δh / l)` where `Δh` is the water-surface height difference (terrain + water) and `l` is the pipe length. Then the **clamp** (§4.4). In place on `flux`.
3. **Water update** — `water[B] = water[A] + dt · (Σ inflow − Σ outflow) / cellArea`, where inflow from neighbour `n` is `flux[n][opposite(dir)]`. A→B.
4. **Evaporation** — `water[B] = max(0, water[B] · (1 − Ke·dt))`. In place on `water[B]`.
5. **Velocity** — derive `vec2` from the 6 flux components projected onto world axes; write `velocity`. Reads `flux`, `water[B]`.

Then swap A/B. Next tick's Input pass runs on the new A.

### 4.4 The stability clamp (outline §3.5 step 2 — "the single most important line")

After the tentative outfluxes are computed in pass 2:

```
totalOut  = (f0+f1+f2+f3+f4+f5) · dt
storedVol = water · cellArea
K         = min(1, storedVol / max(totalOut, ε))
fi       *= K
```

A cell can never route out more water than it holds. This is what prevents negative depths and the classic pipe-model blow-up.

### 4.5 Hex specifics

- **All six neighbours are equidistant.** Pipe length `l = √3 · hexSize` (pointy-top centre-to-centre). Cell area `A_cell = (3√3 / 2) · hexSize²`. One constant each, no per-direction weighting — the whole reason the grid is hex (D8).
- **Neighbour indexing must be row-parity-correct** (D12 — this exact bug has bitten the codebase three times). Storage is `array[r][q + floor(r/2)]`. The neighbour-offset arithmetic is written once as a TS helper, unit-tested against `hex/coords.ts`, and the *identical* arithmetic is ported to WGSL. `opposite(dir) = (dir + 3) % 6` given the `AXIAL_DIRECTIONS` ordering.
- **Map edge is reflective.** A neighbour off the field is simply no pipe (flux 0 that direction). Water reaching the boundary stops. Fine for M3; revisit if it looks wrong.

### 4.6 Fixed timestep

An accumulator in `main.ts`, separate from `requestAnimationFrame`: accumulate real elapsed time (clamped so a backgrounded tab doesn't dump a huge delta), step the sim in fixed `1/30 s` increments, cap at ~5 steps per frame to avoid a spiral of death. Render reads whichever water buffer is current.

### 4.7 Instability watch

The diagnostics overlay gets a sim line: **total water volume**, **max depth**, **ticks/sec**. Volume comes from a GPU reduction pass copied to a mapped readback buffer every ~30 ticks — off the hot path. This is the "assert conservation" mitigation from the risk register.

## 5. Things worth getting right the first time

1. **The neighbour indexing.** Same warning as M0's coordinate helpers. Write it once, test it, port the exact arithmetic. D12 is the receipt.
2. **The clamp.** §4.4. Without it the sim explodes; with it, it's stable almost regardless of the other constants.
3. **Fixed-timestep decoupling.** If M3 accidentally ties sim steps to frame rate, the sim runs at different speeds on iPad vs iPhone and every tuning constant becomes device-dependent.
4. **One submit per tick.** Batch the passes into a single command encoder / submit; don't submit per pass.

## 6. New decision to log when this settles

The CPU-authoritative-terrain / GPU-authoritative-water split (§4.1) is a real architectural boundary. Add it to `02-decisions.md` as **D15** once the first working slice confirms it holds up.

## 7. References

- Mei, Decaudin & Hu (2007), *Fast Hydraulic Erosion Simulation and Visualization on GPU* — passes 1–3 and 6 here; passes 4–5 and 7 are M4.
- *Extended virtual pipes* (2018) — stability improvements for shallow water, if the basic clamp proves insufficient at small depths.
- `bshishov/UnityTerrainErosionGPU` — readable compute-shader pipe model (square grid; adapt neighbour iteration to hex).
- D8 (why hex), D12 (neighbour-parity bug), D13 (sim-first-then-UI sequencing) in `02-decisions.md`.
