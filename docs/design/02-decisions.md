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
- Native iOS is effectively off the table (Xcode is macOS-only). D3 is near-mandatory rather than merely convenient. A future App Store build would need a cloud macOS CI runner. *(Superseded in part by D20/D21: hosted macOS runner or a used Apple-silicon Mac, at M7.)*
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

### D14 — Brush editing architecture: registries, tool-specific interaction models, terrain-conforming cursor *(2026-08-25)*
M2 (in progress). Touch picking is a CPU-side heightfield ray-march (`src/interaction/picking.ts`) against the same flat `Float32Array` the terrain is generated into — not a mesh intersection — refined by bisection once the ray crosses the surface. Simpler than mesh BVH picking and plenty accurate; the height lookup itself (`src/terrain/sample.ts`) is shared with the cursor ring rather than rederived, for the usual D12 reason.

- **Tools and Materials are both plain data arrays** (`TOOLS`, `MATERIALS` in `src/interaction/brush.ts`), not hardcoded UI branches — adding one is an array entry, not new UI code (`src/ui/toolbar.ts` iterates them). Six tools so far: Raise, Lower, Level, Fill to Level, Smooth, Ruggedize. Materials (Sand/Earth/Rock) are a separate selector axis — Raise/Level/Fill-to-Level deposit whichever material is selected; Lower/Smooth/Ruggedize are material-agnostic.
- **Lower removes soil (sand+earth) proportionally**, keeping their ratio intact as the layer shrinks, rather than draining sand to zero before touching earth. Only cuts into rock once soil is genuinely exhausted.
- **Smooth/Ruggedize are restricted to one application per cell per stroke** (a `touchedCellsThisStroke` Set main.ts owns and resets per stroke). Both react to neighbouring cells rather than depositing a fixed amount, so repeated application (holding still, or tracing back over the same spot — either fires many pointer events) compounds; for Ruggedize specifically (a divergent operator — it pushes values *away* from their neighbours) that compounded without limit. An in-call two-pass fix (read all deltas from untouched state, then apply) stopped a single application from exploding, but not the cross-call compounding — the once-per-stroke restriction is what actually fixed it, and is also what makes the Intensity slider mean something predictable. Flagged as P5: works, but Dane thinks there's a better interaction model, revisit before treating this as final.
- **Level and Fill to Level intentionally have different interaction models** despite sharing a "level reference" concept. Level is a single continuous gesture (first touch of a stroke sets the reference, cleared at stroke end). Fill to Level's reference is set by its own discrete tap (no material change, no undo snapshot), then persists across as many separate strokes/regions as the player wants until they deselect the tool or switch tools — built this way specifically to let "sample the water level over here, fill a disconnected basin over there" work in one tool activation.
- **Undo is a bounded stack of full material-array snapshots** (`src/interaction/undoStack.ts`, depth 5), scoped to brush strokes only — regenerating the terrain (sliders/New Seed/Random/Flat) clears it rather than being undoable itself, since correctly undoing a regeneration would mean also tracking the generator parameters in effect beforehand, not just the resulting arrays.
- **The brush cursor ring samples real terrain height per vertex** (computed on the CPU each frame via the shared height lookup, uploaded as a dynamic vertex buffer) rather than sitting flat at one height. The flat version was a deliberate initial simplification to avoid duplicating hex axial math in WGSL, but it got depth-occluded behind ridges from certain camera angles — which looked like the brush was skipping hidden terrain, when the paint logic (pure flat-XZ-distance falloff, no visibility check at all) was actually reaching it correctly the whole time. The ring was lying about what was being painted, not the other way around.

### D15 — M3 water: CPU-authoritative terrain, GPU-authoritative water; textbook pipe model, no ad-hoc damping *(2026-09-02)*
M3's virtual-pipes water sim (`src/sim/waterSim.ts` + `water.wgsl`), confirmed on-device.

**The authority split (the architectural half — `05-m3-brief.md` §4.1, §6).** Everything before M3 was CPU-computed, GPU-rendered: terrain generated into `Float32Array`s, uploaded to `r32float` textures the shaders only `textureLoad`. M3 keeps that for terrain and inverts it for water:
- **Terrain stays CPU-authoritative.** The generator and the brush own `rock`/`earth`/`sand`; brush edits re-upload the touched region to the height texture. The sim only ever *reads* that texture. M2's editing is untouched, and a brush ridge dams live-read terrain on the next tick with zero extra plumbing — verified on-device with the `?demo=dam` scenario.
- **Water is GPU-authoritative.** The generator's flood-fill is uploaded once as the sim's initial state; from then on the sim owns it in ping-ponged storage buffers and there is no meaningful CPU copy. Brush undo does not touch water (it never did anything useful there).
- This boundary is why M4's erosion can stay incremental: erosion is terrain the sim *writes*, which moves the height field from CPU- to GPU-authoritative too — but water, flux and velocity are already there.

**Tuning outcome (the pragmatic half).** Two knobs were tried on top of the textbook Mei et al. model; only one survived:
- `FLOW_STRENGTH` (×8 on the virtual-pipe area) — **kept.** The geometric pipe area moves water like syrup on gentle slopes; this scales it to a watchable speed. Will want re-tuning in M4 when erosion changes the bed under the water.
- `FLUX_DAMPING` (0.9 on against-gradient pipes) — **added, then removed (set to 1.0).** It was meant to bleed slosh momentum, but because it decays flux wherever `dh ≤ 0`, it also erased the small surface gradient that drives water *through* a chain of connected near-flat pools — so distant reservoirs stopped filling and connected bodies never equalised to a common level. Net-negative as implemented. If sloshing returns, address it via `FLOW_STRENGTH` or a depth-aware scheme, not a blanket gradient-sign multiplier.

**Demo vs general sim.** `?demo=dam` runs with **rain and evaporation both off** so the spring is the only inflow and the channel actually fills. With evaporation on, a growing wetted channel reaches an equilibrium where evaporation over the wetted area balances the (clamp-throttled) throughflow reaching the front, and the front stalls partway — realistic, but it makes "watch it fill" read as broken. The general (non-demo) sim keeps both rain and evaporation; evaporation is core to the Qattara premise.

### D16 — Relief shading: hypsometric tint via a data-only theme baked to a 1-D LUT *(2026-09-02)*
Pulled forward from M5 because near-overhead light + no elevation cue + material colour as the dominant channel made terrain relief unreadable, which blocked judging the M3 sim on-device. `src/render/reliefTheme.ts`.

- **A `ReliefTheme` is pure data**: two colour-stop ramps (below / above sea level), the world-height each spans, a material-mix fraction. `buildReliefLUT` bakes it to a 512×1 RGBA8 row; the fragment shader maps a cell's height to a texel (sea level = the centre boundary) and samples it. The shader has **no palette knowledge** — it just reads the transfer function.
- **Swapping themes is data + one texture re-upload** (`TerrainPipeline.setReliefTheme`). This is the deliberate seam for the accessibility / dark-light / contour-band themes Dane wants later, none of which will touch WGSL. Only `CLASSIC_ATLAS` exists now (blues below sea level → green/yellow/brown/pale highlands), signed off 2026-09-02.
- **Sea level is the generator's `waterLevel`**, passed as a uniform and tracking the slider — so the sub-sea-level zone reads distinct even when dry. **Resolves P4.**
- **Light dropped to ~40° altitude** (`lightDir` in `main.ts`) — a near-overhead sun barely varies the diffuse term across slopes; raking light is what casts the tonal gradients that make relief legible. A future theme may want to own the light too.
- Deferred to M5 proper (see P6): tinting only the *actual* water extent rather than everything below sea level, and contour lines.

### D17 — Map edge: frozen world beyond the edge — open sea below sea level, drainable dry land above *(2026-09-23)*
Pulled in before M4 at Dane's request; verified on-device the same day. Replaces M3's reflective (walled) boundary. `src/sim/edgeGhost.ts` + `cs_flux`/`cs_water` in `src/sim/water.wgsl`.

**The rule: the player reshapes the map, never the world beyond it.** Each edge cell has one "ghost" just past the edge: ground frozen at that cell's height *when the terrain was generated* (a perimeter snapshot, `ghostHeight`). Where that frozen ground is below the water level, the ghost is **open sea — an infinite reservoir at the water level**; elsewhere it's **dry land** at the frozen height. Off-field pipes run the ordinary pipe equation against the ghost's surface, so there's one set of physics for both cases:
- **Sea ghost:** pushes water in when the edge cell's surface is below sea level, takes it out when above. A sea-connected basin that gets breached into a dry basin refills from the edge, so *both* end at sea level (the motivating case). Walling off a sea edge above sea level holds the sea outside.
- **Land ghost:** water above the frozen ground drains off the map and never comes back. Rivers flow off-map instead of pooling against an invisible wall (a wall is effectively infinitely high terrain beyond the edge — contradicts the model).

**Why frozen at generation, not live.** Three options were weighed with Dane:
| Ghost is sea where… | Dry basin dug at the edge | Rain |
| --- | --- | --- |
| …edge terrain is below sea level *now* (live terrain) | ❌ spontaneously fills from the edge | — |
| …edge cell is below sea level *and currently wet* (live water) | ✅ stays dry… | ❌ …until rain wets it, then the edge fills it — outcome depends on timing |
| …the edge was sea at generation (**chosen**) | ✅ stays dry (beyond it is land, as it always was) | ✅ rain can fill it, never connects it to the sea |

It's the only option with no dependence on live state, so it's consistent regardless of rain or brushing. The ghosts are rebuilt only on regeneration (`resetWater`), which is also how a water-level slider change reaches them. Every edge cell at or below `waterLevel` at generation is a flood-fill seed (D13), so "ghost is sea" ⇔ "that edge cell was sea" — the two agree by construction; the ghost buffer stores only heights, and sea-vs-land is `ghostHeight <= seaLevel`.

**Implementation notes.**
- An off-field pipe carries **one signed flux** (+ out, − sea inflow) in the existing flux slot. The outflow clamp scales only the positive part — the sea side is infinite, there's nothing to clamp. Land ghosts are clamped to ≥ 0.
- `?demo=dam` passes a sea level below any terrain (`NO_SEA`): all edges are dry land, so the spring stays the only inflow (D15's demo contract).
- **Consequence: total water volume is no longer a closed-domain invariant.** The HUD volume now also moves with edge inflow/outflow (including a steady trickle of rain draining off land edges). M3's "rain off/evap off → vol dead flat" check only holds on `?demo=dam`-style no-sea maps with nothing reaching a land edge. **M4's mass-conservation criterion (`06-m4-brief.md` §3) must be restated to account for material crossing the edge** — either a no-sea test map or explicit edge-flux accounting.
- With evaporation on, a basin fed by a channel from the sea settles slightly below sea level (channel inflow balances evaporation from the basin) — expected, and the real Qattara scheme in miniature, not a bug.

### D18 — Water model: virtual pipes, not Navier-Stokes or SPH *(2026-08-25, merged 2026-09-23)*
*Written as addendum D11 in a Cowork session on 2026-08-25; uploaded to GitHub but not merged until 2026-09-23 (renumbered — the log's D11–D14 were already taken). M3 (D15) has since borne it out.*

`03-outline.md` §3.1 specifies the virtual-pipes model but never recorded what was rejected, which leaves the door open to someone "upgrading" it to a real fluid solver. Don't.

| | Virtual pipes (chosen) | Navier-Stokes / SPH |
| --- | --- | --- |
| Model | Each cell holds a water depth; flux between neighbours is driven by water-surface height difference | Velocity and pressure fields solved per step |
| Pools and settles? | **Yes, naturally** | No — water sloshes indefinitely without extra damping work |
| Cost | One compute pass | Several passes, plus a pressure solve |
| Couples to terrain the player is editing every frame? | **Trivially — same grid** | Badly — the boundary conditions change constantly |
| Prior art for erosion coupling | Extensive | Sparse |

The three reasons, in order of weight:

1. **Pooling and damming are the point of this toy.** A solver that has to be fought into settling is the wrong tool for a game about filling a basin.
2. **The terrain is destructible by design.** Fluid solvers assume boundaries that change slowly. Ours changes wherever the player drags a finger.
3. **Cost.** One pass versus several, on a phone.

Splashing, waves, and spray are explicitly not being chased — see `03-outline.md` §8.

### D19 — The world is bounded, and that is a decision, not a limitation *(2026-08-25, merged 2026-09-23)*
*Addendum D12.* See also D17: the map edge is now an open boundary (sea / drainable land beyond it), but the *simulated* world is still bounded — the ghosts beyond the edge are frozen, not simulated, so this reasoning is unchanged.

`03-outline.md` §8 lists "infinite or streaming worlds" as a non-goal without saying why. Two reasons:

1. **Memory.** ~56 bytes per cell caps the field at 1024 × 1024 (~59 MB) with 1536² as a stretch. See `03-outline.md` §3.4.
2. **The simulation needs to see the whole watershed at once.** This is the load-bearing reason. Hydraulic erosion is a global process — where water goes depends on the entire connected drainage network, not on a local neighbourhood. Stream the world in chunks and rivers stop at chunk boundaries, or worse, behave differently depending on what happens to be resident. A bounded world isn't a compromise here; it's what makes the erosion correct.

### D20 — macOS access: hosted CI runner, not a VM *(2026-08-25, merged 2026-09-23)*
*Addendum D13.* **Amended 2026-09-23 by D21:** Dane may instead obtain a used Mac when M7 arrives; this entry's hosted-runner plan stays the default if not. The VM ruling stands either way.

Supersedes the flat "native iOS is off the table" framing in D10.

**Ruled out: macOS in a VM on the Ubuntu server**

Technically achievable (OSX-KVM / QEMU), but rejected on three grounds:

1. **Licensing.** The macOS Tahoe 26 SLA §2B(iii) permits two virtual instances "on each **Apple-branded computer** you own or control that is already running the Apple Software." An x86 Ubuntu server is not that. Relevant because the endpoint is publishing under a real Apple developer account.
2. **It's a dead end on a timer.** Apple confirmed at WWDC 2025 that **macOS Tahoe 26 is the last release supporting Intel**; macOS 27 is Apple-silicon only. An x86 VM caps out at Tahoe permanently while Xcode moves on.
3. **No GPU acceleration**, which for a WebGPU/Metal app is precisely the thing you'd want to test.

**Chosen: GitHub Actions macOS runners**

- **Free for public repositories.** `dbutters42/qattara` is public, so this costs nothing. (Private repos bill macOS at ~$0.062/min, roughly 10× Linux.) **Keeping the repo public is now a load-bearing decision, not just a default.**
- Real Apple-silicon hardware with Xcode, licensed, triggered by a push.
- Handles build, code-sign, and TestFlight upload — the whole pipeline.

**Still needed separately**

- **Apple Developer Program**, ~$99/yr, for signing and distribution. Not required to *build*, required to *ship*. **Enrolment is not always instant** — individual applications can take days, longer if Apple asks for identity verification. Start it in parallel with R1 rather than discovering the delay later.
- **iPad debugging** is unaffected either way — `ios-webkit-debug-proxy` on Linux plus the in-app diagnostics overlay remain the story. A macOS VM would have needed USB passthrough of the device and wouldn't have helped.

### D21 — iOS delivery path stays at M7, "only if earned" — addendum D14 (TestFlight at M2) not adopted *(2026-09-23)*
Addendum D14 (2026-08-25) proposed pulling the whole Capacitor → signing → TestFlight pipeline forward to immediately after M2, gated on R1. It was never actioned — the addendum wasn't merged, and M3 was built instead. Reviewed with Dane on 2026-09-23: **the App Store / TestFlight path stays at M7, only if the toy earns it.** Its original reasoning is preserved below because it's a genuine argument, not a straw man.

**What changed since it was written:**
- **R1 has cheap positive evidence** (see R1 in `03-outline.md` §10): the dev build renders in **Microsoft Edge on the iPad**. Outside the EU, every iOS browser — Edge and Chrome included — must use Apple's WebKit via `WKWebView`, not its desktop engine (Edge is Chromium on desktop, *not* on iOS). So WebGPU is available in a third-party `WKWebView`, which is what Capacitor uses. Not yet proven: performance parity with Safari, and whether Edge's `WKWebView` configuration differs from Capacitor's default.
- **The addendum underestimated R1's cost.** A proper R1 needs a throwaway iOS app on a real device — impossible without a Mac or the paid Developer Program + CI pipeline. The Edge check is the practical substitute until M7.
- **The honest performance test is M4**, as the addendum's own measurement note says — so deferring the pipeline past M4 loses little.

**Mac option for M7 (researched 2026-09-23).** Dane may buy a used Mac rather than rely solely on the CI runner (D20). Constraints, as of Sep 2026:
- App Store Connect requires builds made with **Xcode 26 / iOS 26 SDK** (since 2026-04-28). Xcode 26 needs **macOS Sequoia 15.6 or later**. Capacitor 8 needs Xcode 26. **So today's floor is macOS 15.6.**
- The floor moves: Apple raises the required SDK roughly every spring, and **macOS 27 is Apple-silicon only** (D20). An Intel Mac tops out at Tahoe 26 and will be unable to run the Xcode that App Store Connect requires within about a year or two.
- **Buy Apple silicon (M1 or later)** — any M-series Mac runs current macOS; an Intel Mac is a dead end for this purpose. Re-check Apple's then-current SDK requirement at purchase time.

**Original addendum D14, for reference:**

**Decision:** pull the entire iOS delivery path forward from M7 to immediately after M2. Prove a signed build installs on Dane's iPad *before* building M3 and M4.

**Why**

1. **Shipping is the actual goal.** Dane's stated ambition for the App Store is "just to say I did it." When the shipping *is* the deliverable, scheduling it last — behind three months of work that could turn out to rest on a broken assumption — is backwards.
2. **Failure is cheap right now and expensive later.** At M2 the app is small. If the delivery path doesn't work, very little is wasted. At M7 it would be months.
3. **The unfun part should happen while motivation is high.** Signing, provisioning profiles, and CI config are nobody's idea of a good evening. Do them while the project is exciting, not at the end when you just want to play the thing.
4. **It converts risk into upside.** Once a signed build is on the iPad, every remaining milestone is pure gain rather than accumulating exposure to an unproven assumption.

**Target: TestFlight *internal* testing — not the App Store**

Internal TestFlight builds **skip App Review entirely**. That means:

- No exposure to Guideline 4.2 (Minimum Functionality), which is what rejects thin webview wrappers.
- No public listing, no rejection on the account's record.
- Still exercises the entire hard part: Capacitor shell → signing → Xcode build on the runner → upload → install on a real device.

Full App Store submission stays deferred until the game is actually worth playing.

**Revised order**

| Step | Proves | Effort |
| --- | --- | --- |
| **R1** — `WKWebView` WebGPU check on a real iPad | Whether any of this is possible **(blocking)** | ~half a day |
| Apple Developer Program enrolment *(start in parallel)* | Unblocks signing | ~$99/yr, days to approve |
| Capacitor wrap + GitHub Actions macOS workflow | The build pipeline | 1–2 days |
| Signed build → TestFlight internal → installed on iPad | **Done. The line is crossed.** | included above |
| M3 — water | The core fantasy | ~2 weeks |
| M4 — erosion | Rivers carve and deposit | 2–4 weeks |
| M5, M6 | Looks, persistence, uplift | open-ended |
| Full App Store submission | Public release | when it's worth playing |

Total cash cost of the delivery path: **$99/yr.** Everything else is free while the repo stays public.

---

## 2. Parked

### P7 — Reference image: ridgeline elevation plot *(uploaded 2026-08-28, logged 2026-09-23)*
`docs/design/Example relief mapping.jpg` — a ridgeline-style ("joy plot") elevation map of the Levant: horizontal elevation profiles on black, coloured blue below sea level → white at sea level → orange → purple peaks. Uploaded by Dane without an accompanying note; its intended use isn't recorded yet (a candidate relief theme under D16's data-only theme system? a style reference for M5?). Ask, then record.

### P6 — Hypsometric tint: actual water extent vs sea-level hinge *(raised 2026-09-02)*
The M5-pulled-forward relief tint (`src/render/reliefTheme.ts`) colours every cell below the current water level blue, whether or not water has actually reached it. Dane wants to consider showing blue only for genuinely-wet cells. Not a trivial change: since M3 the water field is GPU-authoritative in a ping-ponged storage buffer, so the terrain fragment shader would need that buffer bound in (two bind groups, flipped on `sim.currentWaterIndex()` — the pattern `waterPipeline` already uses). It also opens a design question — dry sub-sea-level ground then needs *some* treatment or the "this is a depression" read is lost; a sea-level contour line may be the better answer. Decide at M5 together with the contour-line work.

### P2 — Salinity *(raised 2026-08-25)*
The real Qattara scheme's lake would grow steadily saltier as it evaporates. A plausible later feature with a natural hook into the existing evaporation pass. Not v1.

### P5 — Smooth/Ruggedize interaction model needs a better answer *(raised 2026-08-25)*
Current fix (one application per cell per stroke, tracked via a shared `touchedCellsThisStroke` set — see `src/interaction/brush.ts` / `main.ts`) was needed because Ruggedize is a divergent operator: it explicitly pushes a cell's height away from its neighbours, so repeated application (holding still or tracing back over the same spot, either fires many pointer events) compounded without limit — first seen as a single-tap runaway spike, then again as a slower but still unbounded runaway once the in-call feedback was fixed. Restricting each cell to one shot per stroke solved it and made the Intensity slider meaningful again, but it's a real behavioural compromise: a cell locks in whatever falloff strength it had the *first* moment the brush touched it, so dragging the brush center closer to an already-touched cell mid-stroke does nothing more. Dane's read: usable for now, but there's likely a better model — revisit before relying on this mechanic being final. No specific alternative designed yet.

### P4 — ~~Visual indicator for dry land below water level~~ RESOLVED *(raised 2026-08-25, resolved 2026-09-02)*
Now that dry basins below the current water level are a real, common case (flood-fill only floods what's actually connected — see D13), a player looking at the map has no way to tell "this low ground is dry" from "this low ground would be underwater if connected." **Resolved** by the hypsometric relief tint (`src/render/reliefTheme.ts`, pulled forward from M5 on 2026-09-02): its elevation ramp hinges at the current water level, so any ground below it is blue-tinted regardless of whether water has reached it. See D16 when logged.

### P3 — Camera control inversion toggles *(raised 2026-08-25)*
Current one-finger pan (drag down = camera moves forward) matches a "drag the world" convention (Google Maps-style content-follows-finger), but Dane's own intuition expects the opposite (flight-stick/mouselook-style invert). Both conventions are legitimate and common in different apps/games — this is a preference, not a bug. Two-finger tilt direction has the same question, though Dane finds the current behaviour fine there. Add settings toggles for both once there's a settings surface to put them in (M2+); not urgent enough to build a UI for on its own.
