# 00 — STATE (read this first)

**Project: Qattara** — working title.
**Last updated:** 2026-09-23 (D17 map-edge sea/drain boundary added and verified ahead of M4. Previously: M0–M3 complete — water sim verified on-device, D15; M5 hypsometric relief tint pulled forward and done, D16; all committed on `main`, unpushed. **Next: M4 erosion — brief drafted at `06-m4-brief.md`, not started.**)

---

## 1. The project in four sentences

A god-view landscape toy named after the Qattara Depression Project — the real scheme to flood an Egyptian desert basin with Mediterranean seawater. Rock, earth, and sand terrain on a hexagonal grid, seen from above; rain runs downhill, pools, and carves river channels; the player reshapes the land with brushes and watches the water respond. No player character, no objective, no score. Built as a TypeScript + WebGPU web app targeting Safari on iPad and iPhone.

## 2. Where things stand

| Item | Status |
| --- | --- |
| Brief and name | `01-brief.md` |
| Decisions D1–D17 | Settled — `02-decisions.md`. |
| Design outline | Complete — `03-outline.md` |
| M0 | **Complete** — `04-m0-brief.md`. Go/no-go passed: 60fps on both iPad and iPhone with real geometry. |
| M1 | **Complete.** Procedural generator with player-facing sliders (ruggedness, depth/elevation range, rockiness, sand reach, water level) plus New Seed/Random/Flat presets. See D13. |
| M2 | **Complete.** Touch picking, six brush tools (Raise/Lower/Level/Fill to Level/Smooth/Ruggedize), Materials selector, undo, terrain-conforming cursor ring, collapsible tools panel — all working on-device. See D14. Smooth/Ruggedize's interaction model is still flagged for revisit (P5) but the milestone is done. |
| M3 | **Complete** — `05-m3-brief.md`. Virtual-pipes water sim (3 compute passes/tick, hex neighbour arithmetic in `src/hex/coords.ts` + `src/sim/water.wgsl`), water GPU-authoritative, 30 Hz fixed-timestep accumulator, volume/min/max-depth readback in the HUD. Tuning settled as **D15**: `FLOW_STRENGTH` ×8 kept, `FLUX_DAMPING` tried and removed (it stalled flow through connected pools). All §3 criteria met on-device: damming + flow + connected-pool levelling via `?demo=dam`; conservation/stability via debug `?rain=`/`?evap=` params (rain-off/evap-off → vol constant to float precision; rain-on/evap-off → linear vol, no negatives, 60 fps). Only unverified: iPhone ≥30 fps with the sim (low risk). No erosion — that's M4. |
| Map edge (D17) | **Complete** — built and verified on-device 2026-09-23. Pulled in before M4: world beyond the edge frozen at generation — open sea (infinite reservoir at water level) where the edge was below it, drainable dry land elsewhere. |
| M4 | **Not started** — `06-m4-brief.md` (drafted 2026-09-02). Erosion / deposition, two-channel sediment transport, thermal slumping on top of the M3 pipe model. Completes the D15 authority shift (terrain → GPU-authoritative; **D18** pending). Mostly parameter tuning — a live dev panel is in scope from the first slice. |
| Code | Vite + TypeScript + WebGPU scaffold in `~/projects/qattara` on milliwaysserver. Hex coordinate helpers (tested), hex mesh + procedural terrain generator (tested), displacement/lighting shader, touch orbit camera, brush editing + tool/material UI, undo, GPU water simulation (`src/sim/`), on-device diagnostics overlay. |

## 3. The decisions that matter most

- **Heightmap, not voxels.** Underground is explicitly out of scope.
- **Hexagonal grid**, axial coordinates, six equidistant neighbours — chosen for isotropic water flow and a cleaner triangular render mesh.
- **Three materials**: rock (permanent), earth (durable), sand (washes out fast). Sand and earth mixed per cell, not strictly layered.
- **Virtual pipes hydraulic erosion** (Mei/Decaudin/Hu 2007), adapted to hex, in WebGPU compute shaders.
- **Displaced grid mesh** — editing the world is a texture write, the mesh is never rebuilt.
- **1024 × 1024 cells** is the world-size target; ~56 bytes/cell caps it there.
- No Mac — Windows plus an Ubuntu server. Web is effectively the only iOS path.
- Claude prototypes the engine and sim; Dane owns and tunes the gameplay code.

## 4. Immediate next action — START HERE

**Begin M4 (hydraulic erosion).** The brief is written: `06-m4-brief.md` — read it first, especially §4.1 (terrain becomes GPU-authoritative: sim owns `rock`/`earth`/`sand` buffers, writes the height texture each tick) and §3 (success criteria). Dane has seen the outline and is broadly OK with it but hasn't line-by-line reviewed — expect small adjustments.

**First engine slice:** passes 4 + 5 only — erosion/deposition (`C = Kc·sin(tilt)·|v|`, sand taken before earth, the §4.4 clamps) and flux-based sediment advection — with the **total-solid-mass conservation readout** in the HUD from the first commit (it's to M4 what water-volume conservation was to M3). Hold thermal slumping (pass 7) and the `?demo=erode` scenario until that slice is stable. Build the **dev tuning panel** alongside it, not after (risk register: erosion-param interaction is "High").

Reuse `storageNeighborIndex` / the `water.wgsl` neighbour arithmetic for the tilt gradient — **do not rederive** (D12, fourth time it would bite).

**Also outstanding:** a quick iPhone check that the M3 sim holds ≥30 fps (the one unverified M3 §3 target — low risk; fold into M4's iPhone testing).

**Repo state:** `main`, unpushed, 10 ahead of origin. Session commits: `b2a5ea6` M3 demo + debug water controls + FLUX_DAMPING removal · `ac0a997` M5 relief tint · `21fd018` docs close-out · plus a final docs commit with `06-m4-brief.md`. Working tree clean. `npx tsc --noEmit` clean, 29 tests pass.

**Done (2026-09-02):**
- **M2 complete** — collapsible tools panel (`src/ui/toolbar.ts`), real deselect path, verified on-device.
- **M3 complete (D15)** — virtual-pipes water sim; `FLOW_STRENGTH` kept, `FLUX_DAMPING` removed; damming + flow + conservation all verified on-device.
- **M5 hypsometric relief tint (D16)** — pulled forward because flat-looking terrain was blocking M3 judgement; `CLASSIC_ATLAS` palette signed off; resolves P4.

**Parked, do not forget:**
- P6 — hypsometric tint currently colours everything below sea level blue, flooded or not. Consider tinting only the *actual* water extent (needs the GPU water buffer wired into the terrain pipeline with ping-pong bind groups — medium change), or marking the basin rim with a sea-level contour instead. Decide at M5, alongside contour lines.
- P5 — Smooth/Ruggedize's once-per-cell-per-stroke interaction model works but isn't considered final; look for something better.
- P3 — camera control inversion toggles (pan/tilt), once there's a settings surface to put them in.
- ~~P4 — visual indicator for dry land below water level~~ RESOLVED by the hypsometric tint (§4): the ramp hinges at sea level, so below-sea-level ground is blue-tinted whether or not it's flooded.
- P2 — salinity, a plausible post-v1 addition.
- M5 also: contour-line toggle (quantitative elevation read, ~20 min), and the deferred AO / water shading / material texturing from `03-outline.md`.

## 5. History

This project was scoped in a Claude Cowork session on 2026-08-25. Two decisions were reversed during that conversation and the reasoning is preserved in `02-decisions.md` — D2 (voxels → heightmap) and the addition of D8 (square → hex). Both reversals came from Dane pushing back, and both improved the design.

M0 was built and passed go/no-go the same day (2026-08-25), in a separate session. See D11 in `02-decisions.md` for a dev-workflow correction discovered during that work — the LAN-IP-over-HTTP dev serving assumption in this file and `04-m0-brief.md` turned out not to work for WebGPU and has been corrected.

M1 (procedural terrain generation) was also built the same day, in a third session, iterating directly with Dane against the running app over Tailscale. Notable finds along the way: a real hex-grid neighbour-parity bug affecting the mesh, shading, and generator alike (D12 — will matter again for M4's erosion flux), and a noise-technique artifact in ridged noise fixed by per-octave rotation (also D12). The generator itself — region/macro noise layers, connectivity-based water, independent depth/elevation ranges — is D13.

M2 (brush editing) was started the same day, in a fourth session, again iterating live against the running app. Six tools built (D14) plus undo and a terrain-conforming cursor ring. Finished 2026-09-02 with the collapsible tools panel; **M2 is complete.**

M3 (water) — done 2026-09-02. Virtual-pipes sim on hex: three compute passes per tick, the Mei et al. stability clamp, row-parity-correct neighbour arithmetic shared between `hex/coords.ts` and `water.wgsl`, water GPU-authoritative, a 30 Hz fixed-timestep accumulator decoupled from rAF. Then a long live-tuning arc on the iPad, mostly against the `?demo=dam` scenario, that settled as **D15**: `FLOW_STRENGTH` ×8 kept (raw pipe area flows like syrup); `FLUX_DAMPING` added to fight sloshing then removed once it turned out to also stall flow through connected near-flat pools (distant reservoirs stopped filling, connected bodies wouldn't level off). The §3 conservation check passed on the default map via debug `?rain=`/`?evap=` params — vol constant to float precision with inputs off, linear with rain on, no negative depths.

M5 relief tint (**D16**) was pulled forward mid-M3, because the sim's behaviour couldn't be judged against flat-looking terrain. A hypsometric elevation ramp (`CLASSIC_ATLAS`) baked to a LUT the shader samples, plus a raking-light drop. Structured as a data-only theme so accessibility / dark-light / contour variants are a later data change, not a shader rewrite. Immediately made a real M3 flow bug visible (the `FLUX_DAMPING` stall above). Resolves P4.
