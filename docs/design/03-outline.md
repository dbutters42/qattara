# 03 — PROJECT OUTLINE

The design document. Sections are numbered so they can be referred to and revised individually.

---

## 1. What we're building

A landscape, seen from above, that you can reshape and then watch respond.

Terrain of rock, earth, and sand on a hexagonal grid. Rain falls, water runs downhill, pools in basins, and carves channels. Sand washes out fast; earth holds a bank; rock doesn't move. Water picks material up where it runs fast and drops it where it slows, so rivers build bars and deltas on their own. You reach in with a brush: raise a ridge, cut a notch, drop a boulder, open a spring. Then you watch what the water does about it.

No player character. No objective. No score.

The word for this is **toy**, not game. Design choices get judged on "is it satisfying to poke at," not "is it balanced."

---

## 2. Why a heightmap

A heightmap stores one column of numbers per cell instead of a full 3D grid of voxels. That costs everything underground — caves, tunnels, overhangs, aquifers — and buys three things. It covers vastly more ground area for the same memory, which is what a 10,000-foot view needs. It runs at roughly a tenth the cost. And, decisively, **it makes erosion nearly free** — hydraulic erosion on heightfields is a well-solved published problem with reference implementations, whereas erosion in a voxel grid is a research project.

---

## 3. The simulation

### 3.1 Model

The **virtual pipes** hydraulic erosion model (Mei, Decaudin & Hu, 2007), adapted from its usual square grid to hexagons. Each cell is a column; adjacent columns are joined by imaginary pipes; water flows through them according to the height difference of the water surface.

### 3.2 The grid

Hexagonal, pointy-top, axial coordinates `(q, r)`, stored in a rectangular texture at `array[r][q + floor(r/2)]`. Six neighbours at equal distance, constant offsets, no parity branching. The world footprint is a rhombus or hexagon rather than a square — the map does not have straight edges everywhere, which is fine and was explicitly accepted.

### 3.3 Per-cell data (GPU textures, double-buffered)

| Field | Type | Meaning |
| --- | --- | --- |
| `rock` | f32 | Hard substrate. Effectively non-erodable. |
| `earth` | f32 | Durable erodable material. Holds a steep bank. |
| `sand` | f32 | Fast-eroding material. Slumps at a low angle. |
| `water` | f32 | Depth of standing/flowing water. |
| `susp_earth` | f32 | Earth suspended in that water. |
| `susp_sand` | f32 | Sand suspended in that water. |
| `flux` | 6 x f32 | Outflow to each of the six neighbours. |
| `velocity` | vec2 f32 | Derived from flux; drives erosion strength. |

Terrain surface = `rock + earth + sand`. Water surface = terrain + `water`.

Sand and earth are **mixed within a cell**, not strictly layered. Erosion removes sand preferentially, producing *armouring* — the water strips the sand and leaves the earth behind.

### 3.4 Memory budget — this caps world size

About **56 bytes per cell** (14 floats). Flux no longer fits a single vec4, so it needs two textures or a storage buffer.

| Grid | Cells | Memory | Verdict |
| --- | --- | --- | --- |
| 1024 x 1024 | 1.0 M | ~59 MB | **Target.** Comfortable on iPad and iPhone. |
| 1536 x 1536 | 2.4 M | ~132 MB | Stretch; test on device. |
| 2048 x 2048 | 4.2 M | ~235 MB | Too much for iPhone. |

The sand/earth split cost ~40% more memory than a single soil layer. Worth it, but it's why 2048 squared is off the table.

### 3.5 Passes per simulation tick

1. **Water input** — global rainfall and/or player-placed springs.
2. **Flux update** — outflow to each of six neighbours from water-surface height difference. *Scale outflow down if it would exceed the water actually present.* This clamp is the single most important line of code for stability.
3. **Water and velocity update** — apply net inflow minus outflow; derive velocity from flux.
4. **Erosion / deposition** — sediment capacity from slope and velocity. Over capacity, water lifts material — sand first, then earth, each with its own rate constant. Under capacity, it deposits.
5. **Sediment transport** — advect both suspended channels along the velocity field.
6. **Evaporation** — decay water depth.
7. **Thermal erosion** *(can run less often)* — where a material's slope exceeds its talus angle, slump it downhill. Sand ~34 degrees, earth ~45+, rock effectively never. This is what stops cliffs of loose sand standing forever.

The sim ticks on a fixed clock, decoupled from the frame rate.

---

## 4. Rendering

- **Terrain:** hex cell centres form a triangular lattice, meshing into equilateral triangles with **no diagonal bias** — a quiet advantage over a square grid. Fixed-topology mesh displaced in the vertex shader from the height texture. Start ~512 x 512 vertices sampling a 1024 x 1024 field.
- **The mesh is never rebuilt. Editing the world is a texture write, and costs nothing.**
- **Shading:** normals from height-texture derivatives; colour from which material is exposed, plus slope and wetness. Cheap horizon-based ambient occlusion gives the shaded-relief look that makes terrain maps legible.
- **Water:** second translucent pass at water-surface height, discarded where depth is near zero. Depth-based colour ramp, fresnel, flow-direction distortion from the velocity field.
- **Camera:** orbit, pan, pinch-zoom, tilt clamped away from horizontal. An orthographic top-down "map mode" is nearly free and worth having.
- **Touch picking:** screen ray to terrain intersection to hex cell, using standard pixel-to-hex rounding.

---

## 5. Player tools

| Tool | Effect |
| --- | --- |
| Raise / lower | Brush that adds or removes terrain height |
| Sand brush | Fast-eroding fill — bars, deltas, dunes |
| Earth brush | Durable fill — banks and levees that mostly hold |
| Rock brush | Non-erodable — a dam that lasts forever |
| Spring | Continuous water source at a point |
| Rain | Rainfall over a region, or globally |
| Drain / dry | Remove water |

The three-material ladder is the core design element: a spectrum from "the river will do what it likes with this" to "this is permanent." It's what makes player intent durable in a world that is continuously wearing itself down.

---

## 6. The idle problem

**An erosion simulation left running forever converges to a flat plain.** Peaks wear down, basins silt up, entropy wins. For a toy whose premise is "leave it running and come back," that is a design problem, not a tuning detail.

Recommended counterforces:

1. **Non-erodable rock substrate** — the landscape wears down to its bones and stops. A natural, stable end state.
2. **Slow tectonic uplift** — a region rises while erosion cuts it down. This is what actually happens on Earth, and the uplift/erosion balance produces branching drainage networks. The best fit for idle pacing.
3. *(Rejected)* Rain only on demand — safe, but gives up the "come back and see what happened" hook.

---

## 7. Milestones

| # | Milestone | Proves | Rough effort |
| --- | --- | --- | --- |
| **M0** | Static hex heightmap, displaced mesh, pan/tilt/zoom, in Safari on the iPad | **Go / no-go** on rendering and toolchain | ~1 week |
| M1 | Procedural terrain generation, with player-facing inputs | The world is worth looking at | ~1 week |
| M2 | Brush editing — raise, lower, paint sand / earth / rock | **It becomes a toy** | ~1 week |
| M3 | Water — rain, springs, pipe-model flow, evaporation | Water pools, flows, can be dammed | ~2 weeks |
| M4 | Erosion, two-channel sediment transport, thermal slumping | Rivers carve channels and build deltas | 2-4 weeks, mostly tuning |
| M5 | Looks — relief shading, AO, water shading, material colour | It stops looking like a tech demo | open-ended |
| M6 | Save/load, ambient catch-up sim, uplift | It becomes a place you return to | ~1 week |
| M7 | Capacitor wrap for the App Store | Only if earned; needs a cloud macOS runner | later |

**M0 is a gate.** See `04-m0-brief.md`.

**M2 is the first moment this is fun.** Roughly three weeks in. Optimise the plan for reaching it.

**At the start of M1, ask Dane for his terrain-generation inputs.** He has specific ideas; they should shape the generator, not be bolted on after.

---

## 8. Non-goals

- Anything underground: caves, tunnels, overhangs, aquifers.
- Infinite or streaming worlds.
- Realistic fluid dynamics — waves, splash, spray.
- Multiplayer.
- Progression, resources, currency, upgrades, achievements.
- Android, desktop-first, or VR.

---

## 9. Honest scope estimate

Evenings and weekends, learning as you go: **M0 through M4 is a 2-3 month arc**, with the hex adaptation adding a few days over the square-grid path. Something genuinely playable at M2, in about three weeks. M5 has no natural end and never will.

---

## 10. Risk register

| Risk | Severity | Mitigation |
| --- | --- | --- |
| **Erosion parameter tuning is chaotic** — two materials means more parameters interacting non-linearly | **High** | Build a live parameter panel *at* M4, not after. Tuning is the work, not a polish step. |
| Pipe model goes numerically unstable and water explodes | Medium | The flux clamp in 3.5 step 2; track total water volume and assert conservation |
| Hex adaptation — no reference implementation to copy | Medium | Red Blob Games for grid math; adapt the erosion papers pass by pass. Write hex neighbour helpers once and test in isolation. |
| World flattens to a plain over long idle periods | Medium | Section 6 — non-erodable rock plus slow uplift |
| Fill rate / vertex count on iPhone at 3x retina | Medium | Reduced internal resolution + upscale; mesh density below field resolution; iPad-first |
| No Mac — limited iOS debugging, no native build path | Medium | In-page console overlay; ios-webkit-debug-proxy when needed; cloud macOS runner only if M7 happens |
| Scope creep back toward caves and voxels | Low | Section 8 exists for this reason |

---

## 11. References

- Mei, Decaudin & Hu (2007), *Fast Hydraulic Erosion Simulation and Visualization on GPU* — the source paper.
- Red Blob Games, *Hexagonal Grids* — coordinates, neighbours, storage, pixel-to-hex.
- `bshishov/UnityTerrainErosionGPU` — hydraulic + thermal erosion in compute shaders, readable.
- `huw-man/Interactive-Erosion-Simulator-on-GPU` — interactive, browser-based, closest in spirit.
- *Extended virtual pipes* (2018) — stability improvements for small-scale shallow water.
