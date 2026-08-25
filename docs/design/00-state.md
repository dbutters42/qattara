# 00 — STATE (read this first)

**Project: Qattara** — working title.
**Last updated:** 2026-08-25 (M0 completed same day)

---

## 1. The project in four sentences

A god-view landscape toy named after the Qattara Depression Project — the real scheme to flood an Egyptian desert basin with Mediterranean seawater. Rock, earth, and sand terrain on a hexagonal grid, seen from above; rain runs downhill, pools, and carves river channels; the player reshapes the land with brushes and watches the water respond. No player character, no objective, no score. Built as a TypeScript + WebGPU web app targeting Safari on iPad and iPhone.

## 2. Where things stand

| Item | Status |
| --- | --- |
| Brief and name | `01-brief.md` |
| Decisions D1–D10, D11 | Settled — `02-decisions.md` |
| Design outline | Complete — `03-outline.md` |
| M0 | **Complete** — `04-m0-brief.md`. Go/no-go passed: 60fps on both iPad and iPhone with real geometry. |
| Code | Vite + TypeScript + WebGPU scaffold in `~/projects/qattara` on milliwaysserver. Hex coordinate helpers (tested), static hex mesh + height field, displacement/lighting shader, touch orbit camera, on-device diagnostics overlay. |

## 3. The decisions that matter most

- **Heightmap, not voxels.** Underground is explicitly out of scope.
- **Hexagonal grid**, axial coordinates, six equidistant neighbours — chosen for isotropic water flow and a cleaner triangular render mesh.
- **Three materials**: rock (permanent), earth (durable), sand (washes out fast). Sand and earth mixed per cell, not strictly layered.
- **Virtual pipes hydraulic erosion** (Mei/Decaudin/Hu 2007), adapted to hex, in WebGPU compute shaders.
- **Displaced grid mesh** — editing the world is a texture write, the mesh is never rebuilt.
- **1024 × 1024 cells** is the world-size target; ~56 bytes/cell caps it there.
- No Mac — Windows plus an Ubuntu server. Web is effectively the only iOS path.
- Claude prototypes the engine and sim; Dane owns and tunes the gameplay code.

## 4. Immediate next action

Start **M1** — procedural terrain generation. **Ask Dane for his terrain-generation inputs first** (see Parked, below) before designing the generator.

**Parked, do not forget:** Dane has specific ideas about player-facing terrain-generation inputs. Ask him at the start of M1, before designing the generator.

## 5. History

This project was scoped in a Claude Cowork session on 2026-08-25. Two decisions were reversed during that conversation and the reasoning is preserved in `02-decisions.md` — D2 (voxels → heightmap) and the addition of D8 (square → hex). Both reversals came from Dane pushing back, and both improved the design.

M0 was built and passed go/no-go the same day (2026-08-25), in a separate session. See D11 in `02-decisions.md` for a dev-workflow correction discovered during that work — the LAN-IP-over-HTTP dev serving assumption in this file and `04-m0-brief.md` turned out not to work for WebGPU and has been corrected.
