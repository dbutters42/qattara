# 02 — DECISIONS

Append-only log. When a decision is made, add it here with the date and the reasoning. Do not rewrite history — superseded decisions stay, marked as superseded.

---

## 1. Decided

### D1 — Genre: sandbox toy, not an idle game *(2026-08-25)*
No counters, no upgrades, no progression curve. The simulation runs ambiently and the world keeps changing while the player is away, but nothing accumulates. "Idle" describes the *pacing*, not the mechanics.

### D2 — ~~Simulation model: 3D voxel~~ **SUPERSEDED by D6** *(2026-08-25)*
Originally chosen over heightmap and 2D falling-sand. Reversed once the god-view framing (D5) was clear and the heightmap/voxel trade-off was properly explained.

### D3 — Stack: TypeScript + WebGPU, delivered as a web app / PWA *(2026-08-25)*
WebGPU is enabled by default in Safari on iOS 26 / iPadOS 26. Reinforced by D10 — no Mac, so a native iOS build isn't practically available anyway.

### D4 — Working mode: Claude prototypes, Dane owns gameplay *(2026-08-25)*
Claude builds engine scaffolding and the simulation core with explanations; Dane writes and tunes the parts he'll want to keep fiddling with.

### D5 — Viewpoint: god-view, no player character *(2026-08-25)*
The player is not an entity inside the world. No avatar, no ground-level camera, no first-person anything. Reference point is Google Maps terrain view: a wide overhead look at a landscape, with the ability to edit it and watch what happens. Any Minecraft reference in these docs is about *data and rendering structure* only, never gameplay or viewpoint.

### D6 — Simulation model: 2D layered heightmap, not voxels *(2026-08-25)*
Per-cell columns of material and water. Roughly a tenth the effort of dense voxels, covers far more ground area for the same memory, and — the deciding factor — makes hydraulic erosion, sediment transport, and river channel formation nearly free, where voxels would have made them hard.

**Explicitly given up:** caves, tunnels, overhangs, aquifers. Dane: "maybe if this gets a million downloads." Would require a multi-layered heightmap or a voxel rewrite.

### D7 — Rendering: displaced grid mesh, GPU-resident heightfields *(2026-08-25)*
A fixed-topology mesh whose vertices are displaced in the vertex shader by sampling the height texture. Editing the terrain is a texture write — the mesh is never rebuilt. Water is a second translucent pass at water-surface height.

### D8 — Grid topology: hexagonal, not square *(2026-08-25)*
Dane's suggestion; the better choice, not merely an acceptable one.

- **Six neighbours, all equidistant.** Square grids with 4 neighbours produce visible axis-aligned river artifacts in erosion sims; 8 neighbours only partly fixes it and requires distance-weighting the diagonals. Hex is isotropic by construction.
- **The rendering dual is better too.** Hex centres form a triangular lattice that meshes into equilateral triangles with no diagonal bias. A square grid must pick a diagonal per quad, which shows up in shading.
- **Storage is unchanged.** Axial coordinates `(q, r)` in a rectangular texture: `array[r][q + floor(r/2)]`. Six constant neighbour offsets, no parity branching.
- **Costs:** flux is 6 floats, so it no longer fits a vec4 — two textures or a storage buffer. And every published reference implementation is square-grid, so we adapt rather than copy. Budget a few extra days around M3–M4.
- Decided early because grid topology touches storage, neighbour iteration, mesh generation, touch picking, and noise sampling. Retrofitting would be a rewrite.
- Canonical reference: Red Blob Games, *Hexagonal Grids*.

### D9 — Two erodable materials: sand and earth *(2026-08-25)*
Dane's request. Three solid materials total:

| Material | Erodability | Talus (repose) angle | Role |
| --- | --- | --- | --- |
| Sand | High | Low (~34°) — slumps easily | Washes out fast, forms bars and deltas |
| Earth | Low | High (~45°+) — holds a bank | The durable middle |
| Rock | ~Zero | Near-vertical | Permanent structures |

- **Mixed, not strictly stacked.** Each cell holds amounts of sand and earth rather than enforcing sand-always-on-top. Erosion removes sand preferentially, reproducing *armouring* — water strips the sand and leaves the earth behind. Strict stacking would need insertion logic when depositing earth beneath existing sand; not worth it for v1.
- **Two suspended-sediment channels** so transported material keeps its identity when deposited.

### D10 — No Mac; Windows plus an Ubuntu server *(2026-08-25)*
- Native iOS is effectively off the table (Xcode is macOS-only). D3 is near-mandatory rather than merely convenient. A future App Store build would need a cloud macOS CI runner.
- iOS Safari Web Inspector requires macOS, but remote debugging is possible from Windows/Linux via `ios-webkit-debug-proxy` (open source) or Inspect.dev (paid). Plan for an in-page console overlay (eruda/vconsole) as the low-friction default.
- The Ubuntu server is an asset: serve dev builds over LAN and load them on the iPad by IP. Faster than pushing to GitHub Pages each iteration.

### D11 — Dev workflow: Tailscale Serve over HTTPS, not plain LAN-by-IP *(2026-08-25)*
The workflow assumed in this file and in `04-m0-brief.md` — serve the Vite dev build from the Ubuntu server and open it on the iPad by LAN IP — doesn't work for WebGPU. `navigator.gpu` only exists in a secure context (`https://`, `http://localhost`, or `file://`); a plain `http://192.168.1.18:5173` LAN address doesn't qualify in any browser, regardless of iPadOS/Safari support, and unlike Chrome, Safari has no dev flag to override it. This wasn't discovered until M0 was actually tested on-device.

**Actual working setup:** `tailscale serve` fronting the Vite dev server with a real trusted cert, at `https://<tailnet-host>:8443/` (the iPad needs to be on the same tailnet — it is). Port 443 specifically doesn't work for this on milliwaysserver, because Pi-hole's own webserver already claims it; 8443 is used instead. `claudeai` is the Tailscale operator on that box so this can be reconfigured without sudo. Full detail is in that server's own CLAUDE.md, not repeated here.

**Practical effect:** any future from-scratch dev session on a new device needs this HTTPS setup before WebGPU will initialize at all — plain LAN-by-IP will silently fail with "WebGPU is not available," which looks like a device/OS support problem but isn't.

### D12 — Hex storage neighbour offsets need row-parity awareness everywhere, not just once *(2026-08-25)*
Found during M1 while chasing a visible "parallel striation" artifact across generated terrain. Root causes, in the order found:

1. **Mesh subsampling collapsed the stagger.** Building a coarser mesh from the field by picking every Nth row with a *fixed* column offset lands only on mutually-aligned rows (same-parity rows in this storage scheme have zero relative offset by construction) — silently turning the hex mesh into a plain rectangular grid. Fix: treat the coarse mesh as its own hex lattice (`buildHexMesh` in `src/render/mesh.ts`), not a subsampled subset of the fine one.
2. **Fixed triangle diagonal.** Even with correct stagger, cutting every quad the same way is correct for one row parity and produces sheared (non-equilateral) triangles for the other — reintroducing the exact square-grid diagonal bias hex was chosen to avoid (D8). Fix: alternate the cut direction with row parity.
3. **Shading normals and generator slope, independently.** Both `terrain.wgsl`'s fragment shader and `generator.ts`'s material-placement code compute a central-difference gradient using naive `(x, y±1)` neighbours. Left/right (`x±1`, same row) are genuine hex neighbours regardless of parity; up/down are not — a true hex neighbour one row away needs a column offset that also flips with row parity. Same bug, same fix, in two more places.

**Why this matters beyond M1:** M4's erosion sim computes flux between neighbouring cells on this same storage grid. If it uses naive `(x, y±1)` neighbour offsets the same way, it will silently misroute flow between non-adjacent cells for half the map — the same bug, with a much subtler failure mode (wrong-looking erosion patterns instead of a visible artifact). **Reuse the parity-correct offset logic here rather than rederiving neighbour sampling from scratch.**

A fourth, unrelated bug was found in the same investigation and turned out to be the dominant visible cause: classic simplex noise's zero-crossings can align subtly with its underlying triangular lattice, invisible in ordinary signed noise but exposed as regular ridges by `ridgedFbm`'s `1 - abs(noise)` transform. Fixed by rotating each fBm/ridged octave's sample coordinates by a different angle (`src/terrain/noise.ts`) — the standard fix for this class of artifact, unrelated to the hex-grid bugs above even though it produced a visually similar symptom.

### D13 — Terrain generation: region/macro layers, connectivity-based water, split depth/elevation *(2026-08-25)*
M1's generator, built and tuned over several rounds with Dane. Key structural choices, each because the naive version was tried first and visibly failed:

- **Region map + macro elevation layer**, both large-wavelength/few-octave noise fields independent of the fine-detail noise and of each other. A single global ruggedness/amplitude applied uniformly produced flat, textureless "same everywhere" terrain — no mountain ranges, no plains, no real basins. The region map blends local ruggedness/amplitude around the slider values (mountain-like regions vs plains-like regions); the macro layer adds a separate large-scale elevation trend so basins and plateaus are genuine macro features, not accidents of high-frequency noise. Neither is exposed as a slider yet (wavelength/swing constants are hardcoded) — only the outcome (regional variety) was asked for.
- **Depth range and elevation range are independent sliders**, not one symmetric amplitude. Combine fine + macro noise into a unitless shape value first, then scale by whichever range applies based on sign (below/above height 0). Lets shallow hills coexist with dramatic basins, or the reverse.
- **Water is connectivity-flood-filled from the field's storage boundary, not a flat "below waterLevel -> wet" threshold.** The flat version floods every enclosed low point regardless of whether water could actually reach it — which would auto-flood the game's own founding scenario (a dry basin cut off by a ridge, `01-brief.md`) the instant the world generates. Flood-fill uses true hex connectivity (reuses `hex/coords.ts`'s axial neighbour helpers, not a rederived offset). **Deliberately no size threshold for enclosed basins** — even a large one stays dry until the player breaches it, which is the point of the whole premise. See `floodFillWater` in `src/terrain/generator.ts`.
- **Rock/earth/sand are placed by slope and elevation-vs-waterline**, not independent noise — rock exposes on steep slopes, sand silts up near the waterline, earth fills the rest. Physically motivated, and agrees with the *armouring* concept the erosion sim (M4) will use later.

Resolves P1 (terrain generation inputs) — Dane's requested controls (ruggedness, materials, water level, now split into six sliders total) are implemented, plus New Seed/Random/Flat presets. Built by hand-tuning the algorithm against fixed constants first, adding UI only once the results looked right — see the "get the generator working, then build UI" approach at the start of this session.

---

## 2. Parked

### P1 — ~~Terrain generation inputs~~ RESOLVED, see D13 *(raised 2026-08-25)*
Dane has specific ideas about what the player should be able to control when generating a world. **Ask him at the start of M1** — do not design terrain generation without them.

### P2 — Salinity *(raised 2026-08-25)*
The real Qattara scheme's lake would grow steadily saltier as it evaporates. A plausible later feature with a natural hook into the existing evaporation pass. Not v1.

### P4 — Visual indicator for dry land below water level *(raised 2026-08-25)*
Now that dry basins below the current water level are a real, common case (flood-fill only floods what's actually connected — see D13), a player looking at the map has no way to tell "this low ground is dry" from "this low ground would be underwater if connected." Needs some visual cue at M5 (relief shading/material colour milestone) — options mentioned: slightly darker/different shading below water level, or a contour-line-style indicator at the water-level elevation. Not designed further than that; revisit when M5 starts.

### P3 — Camera control inversion toggles *(raised 2026-08-25)*
Current one-finger pan (drag down = camera moves forward) matches a "drag the world" convention (Google Maps-style content-follows-finger), but Dane's own intuition expects the opposite (flight-stick/mouselook-style invert). Both conventions are legitimate and common in different apps/games — this is a preference, not a bug. Two-finger tilt direction has the same question, though Dane finds the current behaviour fine there. Add settings toggles for both once there's a settings surface to put them in (M2+); not urgent enough to build a UI for on its own.
