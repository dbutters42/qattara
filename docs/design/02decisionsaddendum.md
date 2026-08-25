# 02 — DECISIONS ADDENDUM (D11–D14, R1)

> **Housekeeping:** these entries belong in `02-decisions.md`. Fold them in when convenient and delete this file. Kept separate only because they were written after the original handoff.
>
> **D14 changes the milestone order in `03-outline.md` §7.** Update that table when folding this in.

**Added:** 2026-08-25 (post-M2)

---

## D11 — Water model: virtual pipes, not Navier-Stokes or SPH

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

---

## D12 — The world is bounded, and that is a decision, not a limitation

`03-outline.md` §8 lists "infinite or streaming worlds" as a non-goal without saying why. Two reasons:

1. **Memory.** ~56 bytes per cell caps the field at 1024 × 1024 (~59 MB) with 1536² as a stretch. See `03-outline.md` §3.4.
2. **The simulation needs to see the whole watershed at once.** This is the load-bearing reason. Hydraulic erosion is a global process — where water goes depends on the entire connected drainage network, not on a local neighbourhood. Stream the world in chunks and rivers stop at chunk boundaries, or worse, behave differently depending on what happens to be resident. A bounded world isn't a compromise here; it's what makes the erosion correct.

---

## D13 — macOS access: hosted CI runner, not a VM

Supersedes the flat "native iOS is off the table" framing in D10.

### Ruled out: macOS in a VM on the Ubuntu server

Technically achievable (OSX-KVM / QEMU), but rejected on three grounds:

1. **Licensing.** The macOS Tahoe 26 SLA §2B(iii) permits two virtual instances "on each **Apple-branded computer** you own or control that is already running the Apple Software." An x86 Ubuntu server is not that. Relevant because the endpoint is publishing under a real Apple developer account.
2. **It's a dead end on a timer.** Apple confirmed at WWDC 2025 that **macOS Tahoe 26 is the last release supporting Intel**; macOS 27 is Apple-silicon only. An x86 VM caps out at Tahoe permanently while Xcode moves on.
3. **No GPU acceleration**, which for a WebGPU/Metal app is precisely the thing you'd want to test.

### Chosen: GitHub Actions macOS runners

- **Free for public repositories.** `dbutters42/qattara` is public, so this costs nothing. (Private repos bill macOS at ~$0.062/min, roughly 10× Linux.) **Keeping the repo public is now a load-bearing decision, not just a default.**
- Real Apple-silicon hardware with Xcode, licensed, triggered by a push.
- Handles build, code-sign, and TestFlight upload — the whole pipeline.

### Still needed separately

- **Apple Developer Program**, ~$99/yr, for signing and distribution. Not required to *build*, required to *ship*. **Enrolment is not always instant** — individual applications can take days, longer if Apple asks for identity verification. Start it in parallel with R1 rather than discovering the delay later.
- **iPad debugging** is unaffected either way — `ios-webkit-debug-proxy` on Linux plus the in-app diagnostics overlay remain the story. A macOS VM would have needed USB passthrough of the device and wouldn't have helped.

---

## D14 — Ship the pipeline early: TestFlight at M2, not M7

**Decision:** pull the entire iOS delivery path forward from M7 to immediately after M2. Prove a signed build installs on Dane's iPad *before* building M3 and M4.

### Why

1. **Shipping is the actual goal.** Dane's stated ambition for the App Store is "just to say I did it." When the shipping *is* the deliverable, scheduling it last — behind three months of work that could turn out to rest on a broken assumption — is backwards.
2. **Failure is cheap right now and expensive later.** At M2 the app is small. If the delivery path doesn't work, very little is wasted. At M7 it would be months.
3. **The unfun part should happen while motivation is high.** Signing, provisioning profiles, and CI config are nobody's idea of a good evening. Do them while the project is exciting, not at the end when you just want to play the thing.
4. **It converts risk into upside.** Once a signed build is on the iPad, every remaining milestone is pure gain rather than accumulating exposure to an unproven assumption.

### Target: TestFlight *internal* testing — not the App Store

Internal TestFlight builds **skip App Review entirely**. That means:

- No exposure to Guideline 4.2 (Minimum Functionality), which is what rejects thin webview wrappers.
- No public listing, no rejection on the account's record.
- Still exercises the entire hard part: Capacitor shell → signing → Xcode build on the runner → upload → install on a real device.

Full App Store submission stays deferred until the game is actually worth playing.

### Revised order

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

## R1 — BLOCKING RISK: WebGPU inside WKWebView is unverified

**Severity: high. Under D14 this now blocks the immediate next step, not a distant milestone.**

Capacitor wraps the app in a `WKWebView`, not Safari. WebGPU shipped enabled-by-default in **Safari** 26 on iOS and iPadOS. Whether it is equally available inside a third-party app's `WKWebView` — with no entitlement, no flag, and no performance penalty — **has not been confirmed.** Apple's WebKit announcements describe Safari; they are silent on WKWebView.

If WebGPU is absent or degraded there, the Capacitor path does not exist as planned, and the delivery approach needs rethinking from scratch.

**Do this first, before anything else in D14:**

1. Write a throwaway iOS app (or minimal Capacitor shell) containing a `WKWebView` that loads a page calling `navigator.gpu.requestAdapter()`.
2. Run it on a real device. Confirm an adapter is returned, and that a trivial compute pass matches Safari's performance.
3. Record the result here as a decision, pass or fail.

Half a day. It either unlocks D14 or saves months of building toward something that can't ship.

---

## Note on measurement

M2 currently runs at 60 fps, but M2 has no simulation in it. The seven compute passes per tick arrive at M3 and M4, and that is where the GPU budget actually gets spent. **The honest test of "is a webview fast enough" is M4, not now.**

Add GPU timestamp queries when M3 lands so that by M4 there are real per-pass timings. WebGPU `timestamp-query` is reported as widely available on iOS — verify on device rather than assuming. Without those numbers, any future "should we go native?" conversation is just an argument.

*(For the record: native — Swift + Metal — was considered and rejected. It requires a Mac for daily development, not merely for CI, and would mean discarding M0–M2 and learning two new technologies. The GPU work runs on the same silicon either way; WebGPU is a thin layer over Metal. The genuine losses are memory headroom above 1024² and Xcode's GPU frame capture. Neither justifies the switch.)*
