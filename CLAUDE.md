# Qattara

A god-view landscape toy. Rock, earth, and sand terrain on a hexagonal grid, seen from above. Rain runs downhill, pools, and carves river channels. The player reshapes the land with brushes and watches the water respond. No player character, no objective, no score.

Named after the **Qattara Depression Project** — the real, repeatedly-proposed scheme to flood an Egyptian desert basin 133 m below sea level with Mediterranean seawater.

**Target:** Safari on iPad and iPhone (iOS 26+, for WebGPU). TypeScript + WebGPU, delivered as a web app.

---

## Read this first

Design context lives in `docs/design/`. Read it before writing code:

| File | What's in it |
| --- | --- |
| `docs/design/00-state.md` | Where the project stands; read first |
| `docs/design/01-brief.md` | Vision, name, goals, non-goals |
| `docs/design/02-decisions.md` | Decision log D1–D10 with reasoning. Append, don't rewrite. |
| `docs/design/03-outline.md` | The design document: simulation, rendering, milestones, risks |
| `docs/design/04-m0-brief.md` | The current milestone, in detail |

Keep these current. When a decision gets made, append it to `02-decisions.md` with a date and the reasoning. When the project state changes, update `00-state.md`. These files are the memory — a session that starts cold reads them and knows where things are.

---

## Architecture in one screen

- **Grid:** hexagonal, pointy-top, axial coordinates `(q, r)`, stored in a rectangular texture at `array[r][q + floor(r/2)]`. Six equidistant neighbours, constant offsets, no parity branching. Chosen for isotropic water flow — square grids produce visible axis-aligned river artifacts.
- **World:** 1024 × 1024 cells, ~56 bytes/cell, ~59 MB. Bounded, not infinite. No underground.
- **Materials:** rock (non-erodable), earth (slow, holds ~45° banks), sand (fast, slumps ~34°). Sand and earth are *mixed* per cell, not strictly layered.
- **Simulation:** virtual-pipes hydraulic erosion (Mei, Decaudin & Hu 2007), adapted from square to hex, in WebGPU compute shaders. Seven passes per tick, fixed tick rate decoupled from frame rate.
- **Rendering:** fixed-topology triangle mesh displaced in the vertex shader from the height texture. Hex centres form a triangular lattice — equilateral triangles, no diagonal bias. **The mesh is never rebuilt; editing the world is a texture write.**
- **Water:** second translucent pass at water-surface height.

---

## Working agreement

- Dane is learning as he goes and says so plainly. Explain the *why*; don't just hand over code.
- Be direct and skeptical. Don't agree by default. If his reasoning is weak, say so — and if his idea is better than the textbook answer, say that too. The hex grid was his call and it was the right one.
- Format for scanning: bolded verdict first, numbered points with bold stubs, tables for anything comparative. No walls of text.
- **One question at a time.** If a step needs his answer, stop and wait for it. Don't stack unanswered asks.
- Flag anything at risk of being lost when a session ends or a milestone lands, and ask whether it should be written into `docs/design/`.

## Parked — do not forget

Dane has specific ideas about **player-facing terrain-generation inputs**. Ask him for these at the start of M1, before designing the generator. Do not bolt them on afterward.

## Dev environment notes

- No Mac. Windows desktop plus an Ubuntu server. Native iOS is off the table; a future App Store build would need a cloud macOS runner.
- Serve dev builds from the Ubuntu server over LAN and open them on the iPad by IP — faster than pushing to GitHub Pages each iteration.
- iOS Safari Web Inspector needs macOS. Use an in-page console overlay (eruda / vconsole) by default; `ios-webkit-debug-proxy` when real DevTools are needed.
- GitHub Pages serves the stable build. Repo must stay public for Pages on a free account.
