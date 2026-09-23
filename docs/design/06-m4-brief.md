# 06 — M4 BRIEF: EROSION

**Status:** not started.
**Purpose:** the water actually reshapes the land. Moving water picks up sand and earth, carries it, and drops it where it slows — so rivers cut channels, valleys widen, and deltas build where a stream meets standing water. Loose material slumps to its angle of repose. This is the milestone the whole project is pointed at, and — per the risk register — it is *mostly parameter tuning*, not new code.

---

## 0. Progress

Nothing yet. M3 (`05-m3-brief.md`) is the foundation: the pipe model, the `water` / `flux` / `velocity` fields, the 30 Hz accumulator, the conservation readback, the `?demo=` / `?rain=` / `?evap=` debug hooks. M4 adds passes 4, 5 and 7 of `03-outline.md` §3.5 on top of that.

## 1. What M4 must do

- **Erosion / deposition.** Where water has spare carrying capacity (steep + fast), it lifts material into suspension — **sand before earth**, each at its own rate. Where capacity is exceeded (flat + slow + deep), it deposits. Rock never erodes.
- **Sediment transport.** Suspended sand and earth move with the water, as two independent channels.
- **Thermal erosion (slumping).** Where a material's local slope exceeds its talus angle, it slides downhill until it doesn't. Sand ~34°, earth ~45°, rock effectively never. This is what stops a vertical sand wall standing forever.
- **Armouring falls out for free.** Because sand erodes preferentially, water strips the sand from a mixed cell and leaves the earth — the channel bed coarsens and erosion slows on its own. No special-case code; it's what the per-material rates produce.
- **Mass is conserved.** `rock + earth + sand + suspended` over the closed field is constant to float precision when nothing is being added. Terrain never erodes below its rock; suspended sediment never goes negative or runs away.
- **A live tuning panel exists.** The erosion constants (capacity, erode rates, deposit rate, talus angles, thermal rate) are adjustable against the running sim on-device. Tuning *is* the milestone (risk register); the panel is not a polish step to add afterward.

## 2. Explicitly NOT in M4

- **No uplift, no tectonics.** The land only wears down this milestone. Uplift (the thing that stops the world flattening to a plain over long idle periods) is M6, with the ambient catch-up sim.
- **No sediment or water *rendering* work.** Suspended sediment is not drawn; muddy-water tint, foam, wet-sand darkening, flow lines — all M5. M4 is validated through **terrain change** (the relief tint already shows a delta building as the ramp colour shifts) plus the diagnostics HUD.
- **No player-facing erosion controls.** Rain rate, spring/drain brushes, an erosion-strength slider for the player — designed *after* the sim is proven and stable, same sequencing as M1's generator (D13) and M3's water. The M4 panel is a **dev** tuning surface.
- **No save/load of sediment/erosion state.** M6.
- **No new material types, no chemical weathering, no vegetation.** Rock / earth / sand, as defined in D6.
- **No attempt at quantitative realism.** Match *plausible behaviour* — branching channels, deltas, graded slopes — not measured erosion rates.

## 3. Success criteria

| Criterion | Target |
| --- | --- |
| Frame rate on iPad, all 7 passes running | 60 fps |
| Frame rate on iPhone | ≥ 30 fps (the M3 iPhone check is also still outstanding — do both) |
| Sim resolution | Full 1024 × 1024. Half-res fallback only if profiling forces it. |
| Tick rate | Fixed 30 Hz, decoupled from render (unchanged from M3). Thermal pass may run every Nth tick. |
| **Mass conservation** | Rain off, no springs, closed field → total solid mass (`rock+earth+sand+suspended`)·cellArea constant to float precision. **Since D17 the field isn't closed** — water (and so suspended sediment) crosses the map edge. Test on a no-sea map with nothing reaching an edge (as `?demo=dam` does), or account for edge flux explicitly; decide which at M4 start. No cell's earth/sand/suspended goes negative. Nothing oscillates or explodes. |
| **Armouring** | Run water across a cell of mixed sand+earth → sand depletes first, earth remains, local erosion rate drops as it coarsens. |
| **Channel incision** | Rain or a spring on a broad slope → a defined channel cuts over sim-minutes (not instantly, not never), and tributaries join it. |
| **Delta / deposition** | Where moving water enters standing water or a flat → terrain builds outward/upward there; the suspended load drops as the water slows. |
| **Thermal slumping** | Brush a near-vertical sand wall → it collapses to ~34°. An earth wall holds visibly steeper. Rock stays put. |
| **Stable under the brush** | Erode terrain while the player is actively editing it (M2 path) → no explosion at the CPU-write / GPU-erode boundary. |

If frame rate doesn't hold: thermal pass less often → fewer erosion sub-steps → half-res sediment fields with bilinear upscale → half-res whole sim. Reconsider the model only if all fail.

### 3.1 Repeatable demo scenarios

Same idea as `?demo=dam` — fixed, deterministic stages so tuning is reproducible. Likely `?demo=erode` (a fixed seed with a long even slope + a hardcoded spring at the top, rain off — watch one channel carve) and possibly `?demo=talus` (a brushed vertical wall of each material — watch them slump). Defined properly when M4 starts; keep it to one or two.

## 4. Architecture

### 4.1 The shift: terrain becomes GPU-authoritative

M3 established the boundary (D15): terrain was CPU-authoritative, the sim only *read* the height texture. Erosion writes terrain every tick, so `rock` / `earth` / `sand` have to live where the compute passes can mutate them.

**Recommended approach — the sim owns them as storage buffers, and refreshes the render textures each tick:**

- At M4 start, seed three `array<f32>` buffers (`rock`, `earth`, `sand`) from the generator's existing CPU arrays.
- **Brush edits stay on the CPU** (M2 untouched). After a stroke's region is recomputed, upload that sub-range to the sim's buffers (`writeBuffer` with an offset) as well as / instead of the render texture. The brush is authoritative for *player* edits; the sim is authoritative for *erosion*; they write disjoint-in-time so last-writer-wins per region is fine.
- After the erosion + thermal passes each tick, write the combined surface height (`rock+earth+sand`) into the existing `heightTexture` — a small dedicated pass, or `copyBufferToTexture` (1024×4 = 4096 B/row, already 256-aligned). Optionally refresh the `earth` / `sand` textures too; the relief tint's material term is only ~20% so a frame of staleness there is invisible, but the water sim reads height every tick and must see the current bed.
- Net effect: the displaced mesh, the relief shader, and the M3 water passes all keep reading textures exactly as they do now. Only the *source* of the height texture changes.

Alternative considered: `heightTexture` etc. as read-write `r32float` storage textures the passes write directly (no buffer copy). Fewer moving parts, but storage-texture read-write support is newer and the buffer path keeps the indexing arithmetic explicit, matching the rest of the sim. **Decide and log as D22** once the first slice works.

### 4.2 New per-cell state

| Field | Layout | Ping-pong? | Notes |
| --- | --- | --- | --- |
| `rock` | `array<f32>`, W·H | No | Erosion floor. Never removed. |
| `earth` | `array<f32>`, W·H | No — in place | Eroded/deposited each tick. |
| `sand` | `array<f32>`, W·H | No — in place | Eroded/deposited each tick; goes first. |
| `suspEarth` | `array<f32>`, W·H | **Yes** (A/B) | Earth carried in the water. Advected. |
| `suspSand` | `array<f32>`, W·H | **Yes** (A/B) | Sand carried in the water. Advected. |

`water` already ping-pongs (M3); `flux` and `velocity` are unchanged. The two suspended channels double-buffer for the advection pass (§4.3 pass 5) the same way `water` does. Memory: the outline budgeted 56 B/cell single-buffered; double-buffering `water` + `suspEarth` + `suspSand` adds 12 B/cell → ~68 B/cell → ~71 MB at 1024² — still comfortably inside the iPad/iPhone target.

### 4.3 Passes per tick

Passes 1–3 and 6 are M3, unchanged. M4 inserts 4 and 5 after the water update, and 7 at the end (optionally every Nth tick). One command encoder, one submit, as M3.

1. Water input (rain + springs) — M3
2. Flux update + clamp — M3
3. Water + velocity update — M3
4. **Erosion / deposition** — new
5. **Sediment advection** — new
6. Evaporation — M3
7. **Thermal erosion** — new, may run every Nth tick

**Pass 4 — erosion / deposition.** Per cell:
- Local tilt `α` from the parity-correct 6-neighbour height gradient (§4.5). Speed `|v|` from `velocity`.
- Transport capacity `C = Kc · sin(α) · |v|`, floored at a small `sin(α)` so flat fast sheets still carry a little (tunable).
- Total currently suspended `s = suspSand + suspEarth`.
- If `C > s` (spare capacity): erode `amount = min(Ks·(C − s)·dt, availableSand)` from `sand` into `suspSand`; if capacity remains, erode `Ke·(…)·dt` from `earth` into `suspEarth`. **Sand is always taken before earth** — this is the armouring mechanism. Never touch `rock`.
- If `C < s` (over capacity): deposit `Kd·(s − C)·dt`, split between the two channels in proportion to how much of each is suspended, back onto `sand` / `earth`.
- Adjust the cell's height implicitly — `height = rock + earth + sand`, so changing `earth`/`sand` *is* the terrain edit.

**Pass 5 — sediment advection.** Grid-native, flux-based — **not** semi-Lagrangian off-grid sampling (hex makes that ugly). Move suspended material between cells in proportion to the water flux already computed in pass 2: cell `i` sends `suspX[i] · (fluxOut_d / waterBefore[i])` along direction `d`, and receives each neighbour's send toward it (`flux[n][opposite(d)] / waterBefore[n]`). Reuses `neighborIndex` / `oppositeDirection` exactly like `cs_water`. A→B on both suspended channels. Conserves suspended mass exactly by construction.

**Pass 7 — thermal erosion.** Per cell, for each of 6 neighbours lower than it:
- `Δh = height_here − height_n`. Talus slope for the material on top (sand if any sand present, else earth) is `tan(θ_mat)`; `θ_sand ≈ 34°`, `θ_earth ≈ 45°`, rock never slumps.
- If `Δh / pipeLength > tan(θ_mat)`: move a fraction `Kt` of the excess volume (`Δh − tan(θ_mat)·pipeLength`) of that material from `here` to `n`, split evenly among all neighbours that qualify. Clamp to the material actually available.
- Runs every Nth tick (N ≈ 4) if frame budget is tight — slumping is slow and doesn't need 30 Hz.

### 4.4 The stability lines (M4's version of M3 §4.4)

Two clamps, each "the single most important line" for its pass:

1. **Erosion can't remove more than is there.** `erodedSand = min(rate·dt, sand[i])`, then earth against `earth[i]`. Deposition can't deposit more than is suspended: `deposited = min(rate·dt, susp[i])`. Without these, `earth`/`sand`/`susp` go negative and the terrain oscillates or blows up.
2. **Advection can't send more suspended than the water it rides on carries.** The per-direction fraction `fluxOut_d / waterBefore[i]` must be computed from the *same* `waterBefore` the flux was derived from, and the six fractions summed must be clamped to ≤ 1 (they already are if pass 2's flux clamp held, but assert it).

### 4.5 Hex specifics

- **Tilt / gradient uses the parity-correct 6-neighbour arithmetic.** This is the fourth place the same D12 bug can land — after the mesh, the shading, the generator, and M3's flux. Erosion misrouting flow for half the map fails *subtly* (wrong-looking channel patterns, not an obvious artifact). Reuse `storageNeighborIndex` / the `water.wgsl` port; do not rederive.
- **Talus comparison is against `tan(θ)·pipeLength`**, where `pipeLength = √3·hexSize` — the same centre-to-centre distance the pipe model uses. One constant per material.
- **Flux-based advection** (§4.3 pass 5) is the hex-friendly choice precisely because it never samples off the grid.
- **Map edge stays reflective.** Sediment reaching the boundary stops there (no pipe off-field). Fine for M4.

### 4.6 Instability watch

The HUD sim line gains:
- **Total solid mass** `(rock+earth+sand+suspEarth+suspSand)·cellArea` — the erosion analogue of M3's water-volume conservation check. Constant when nothing is added.
- **Max suspended depth** and **max single-tick terrain change** — early warning of a blow-up before it's visible.

Same non-blocking readback path as M3's volume stat (a reduction copied to a mapped buffer every ~30 ticks, off the hot path).

## 5. Things worth getting right the first time

1. **Track mass conservation from the first slice.** It is to M4 what water-volume conservation was to M3 — the assertion that catches a broken clamp before it's a visible mess.
2. **The two clamps in §4.4.** Erosion/deposition bounded by what's actually present; advection bounded by the carrying water. Everything else tolerates a wide range of constants; these don't.
3. **Parity-correct neighbour gradients (D12).** Fourth time. Reuse, don't rederive. The failure mode here is subtle, which makes it worse.
4. **Flux-based advection, not off-grid sampling.** Grid-native, exactly conservative, no hex interpolation headache.
5. **Per-pass GPU timings from the first slice.** From the merged 2026-08-25 addendum (see D21), originally meant to land at M3 and never done: add WebGPU `timestamp-query` around each compute pass and show per-pass ms in the HUD. `timestamp-query` is *reported* available on iOS — verify on-device; fall back to whole-submit timing via `onSubmittedWorkDone` if not. M4 is the honest "is a webview fast enough" test, and without real per-pass numbers every "should we go native / half-res?" conversation is an argument.
6. **Build the tuning panel with the sim, not after.** The risk register calls erosion-parameter interaction "High" severity. Live sliders for `Kc`, `Ks`, `Ke`, `Kd`, the talus angles and `Kt`, against `?demo=erode`, from the first working slice.
7. **Keep the terrain-authority migration boring.** The sim owns `rock`/`earth`/`sand` buffers and writes the height texture each tick; the mesh, relief shader and M3 water passes should not need to change how they read anything.
8. **One submit per tick still.** Seven passes in one command encoder.

## 6. New decisions to log when this settles

- **D22** — how terrain becomes GPU-authoritative: the sim-owns-buffers + texture-writeback approach of §4.1 (vs read-write storage textures), once the first slice confirms it.
- Possibly a short decision on **flux-based sediment advection on hex** if the reasoning turns out worth preserving (it's the natural consequence of D8 + D12, but M4 is where it's first actually built).
- The eventual **erosion constants** that survive tuning — record the final set and what each visibly controls, the way D13 recorded the generator.

## 7. References

- Mei, Decaudin & Hu (2007), *Fast Hydraulic Erosion Simulation and Visualization on GPU* — passes 4 and 5 here (capacity / erode / deposit / transport). The source paper; M3 did passes 1–3 and 6.
- `bshishov/UnityTerrainErosionGPU` — hydraulic **and thermal** erosion in compute shaders, readable. Square grid; adapt neighbour iteration to hex.
- `huw-man/Interactive-Erosion-Simulator-on-GPU` — browser-based, interactive, closest in spirit; good reference for the live-tuning workflow.
- *Extended virtual pipes* (2018) — shallow-water stability, if the basic clamps prove insufficient at small depths.
- D6 (three materials, mixed per cell, armouring), D8 (why hex), D12 (neighbour-parity bug — read before writing the gradient code), D13 (sim-first-then-UI sequencing), D15 (the CPU/GPU authority split M4 completes) in `02-decisions.md`.
