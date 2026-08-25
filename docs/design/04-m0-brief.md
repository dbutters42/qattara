# 04 — M0 BRIEF

**Status:** complete, go/no-go passed (2026-08-25).
**Purpose:** M0 is a **go / no-go gate**. It proves the rendering approach and the WebGPU toolchain work on the actual target device before anything else gets built.

---

## 1. What M0 must do

Render a **static** hex heightmap as a displaced 3D mesh, and let the user pan, tilt, and zoom it, in Safari on an iPad.

No simulation. No editing. No water. No procedural generation worth the name — a couple of sine waves or a single noise octave is enough to make relief visible.

## 2. Success criteria

| Criterion | Target | Result |
| --- | --- | --- |
| Sustained frame rate on iPad | 60 fps | **60 fps**, met |
| Frame rate on iPhone | ≥ 30 fps | **60 fps**, exceeded |
| Grid | 1024 × 1024 hex cells in the height field | Met |
| Mesh | ~512 × 512 vertices sampling that field | Met |
| Camera | Pan, pinch-zoom, tilt (clamped away from horizontal), all touch-driven | Met — also added two-finger orbit (yaw), not originally listed here but needed to make the camera actually usable |
| Loads over LAN from the Ubuntu dev server on the iPad | Yes | **Corrected, not as originally assumed** — see D11 in `02-decisions.md`. Plain LAN-by-IP over HTTP doesn't work for WebGPU (needs a secure context); actual setup is Tailscale Serve over HTTPS. |

**If these numbers don't hold, stop and revisit the architecture.** Do not proceed to M1 on a failing M0. Options at that point include reducing mesh density, reducing field resolution, rendering at lower internal resolution and upscaling, or reconsidering the displaced-mesh approach entirely.

*(Not needed this time — both platforms passed comfortably.)*

## 3. Scope boundaries

**In scope:** project scaffolding, WebGPU device setup with a clear failure message on unsupported browsers, the hex-to-world coordinate helpers, a triangular mesh generated from hex centres, a vertex shader that displaces from a height texture, basic directional lighting with normals from height derivatives, touch camera controls, an on-screen FPS and diagnostics overlay.

**Out of scope:** water, erosion, materials beyond a single height value, brushes, saving, terrain generation parameters, anything pretty.

## 4. Things worth getting right the first time

1. **The hex coordinate helpers.** Axial `(q, r)` ↔ world position, the six neighbour offsets, pixel-to-hex rounding. Write them once, test them in isolation, and don't touch them again. Everything downstream depends on them.
2. **The diagnostics overlay.** Frame time, draw calls, device limits, and a visible error surface. There's no Web Inspector on iPad without a Mac, so on-screen diagnostics are the debugging story. Build it at M0, not later.
3. **Fixed mesh topology.** The mesh is generated once and never rebuilt. If M0 accidentally establishes a pattern of regenerating geometry, that assumption will be expensive to unwind at M2.

## 5. Suggested stack

Vite + TypeScript, no framework. WebGPU directly rather than through a wrapper — this is an educational project and the abstraction would hide exactly the parts worth understanding.

## 6. Reference

- Red Blob Games, *Hexagonal Grids* — coordinates, neighbours, storage, pixel-to-hex.
- WebGPU is enabled by default in Safari on iOS 26 / iPadOS 26. There is no fallback for older iOS and none is planned.
