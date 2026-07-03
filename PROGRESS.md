# Progress log

Running log of build progress, findings, and decisions. Newest entries at the bottom of each milestone section. See PLAN.md for the full plan; task checklist mirrors its milestones.

## Decisions locked at kickoff (2026-07-03)

- Plain CSS (no Tailwind).
- Build M1→M6 straight through; export spike between M1 and M2.
- Git: frequent granular commits.
- Defaults: 16:9 canvas, 1080p export baseline.

## Environment notes

- Node v22.11.0, npm 10.9.0, git 2.25.1 (no `init -b`), ffmpeg available, Chrome at /usr/bin/google-chrome for headless verification.
- M5 recorder (`getDisplayMedia`) and "plays in QuickTime/VLC" checks need a human pass — flagged for William.

## M1 — Skeleton + import + styled preview

- Scaffolded: tsconfigs (vite react-ts style), `src/engine/` (types, compositor, camera, easing), `src/state/store.ts` (Zustand), preview UI (drop zone + import button, rAF render loop, play/pause + time readout), settings panel (aspect presets, 6 background presets, padding/radius/shadow sliders). Plain CSS dark theme.
- Design note: camera/zoom math (eased zoom segments → source crop) implemented in the engine already since the model was clear — M2 only needs UI (drag-to-define region, scrubber, track). Compositor is pure `(ctx, project, timeMs, frame)`; preview and export share it.
- `npm run build` (tsc + vite) passes.
- Verification harness: `scripts/verify.mjs` boots vite + headless system Chrome via playwright-core; `scripts/verify-m1.mjs` imports an ffmpeg-generated 5s test clip, pixel-checks background vs video content, playback advance, aspect preset switch. Screenshots → `test-output/`.
