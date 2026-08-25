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

---

## 2. Parked

### P1 — Terrain generation inputs *(raised 2026-08-25)*
Dane has specific ideas about what the player should be able to control when generating a world. **Ask him at the start of M1** — do not design terrain generation without them.

### P2 — Salinity *(raised 2026-08-25)*
The real Qattara scheme's lake would grow steadily saltier as it evaporates. A plausible later feature with a natural hook into the existing evaporation pass. Not v1.
