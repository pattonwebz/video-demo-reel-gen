# Demo Reel Generator — browser-based screen-demo editor

## Context

A Screen Studio / Anthropic-launch-video style tool: feed in one or more short screen recordings and produce a polished demo reel — animated zoom/pan ("camera"), click highlights, styled background frame, captions, exported as MP4. Runs entirely in the browser.

Decisions made:

- **Input**: record in-app (screen capture + cursor/click telemetry for auto-zoom) **and** accept uploaded videos (manual zoom keyframes for those).
- **Editing model**: visual timeline editor with auto-suggested zooms/effects the user can tweak.
- **Stack**: free/open — no Remotion (paid company license). Custom canvas compositor + **Mediabunny** (MPL-2.0) for in-browser decode/encode/mux.
- **Scope**: internal tool for the team; no auth/multi-tenancy; rough edges OK.

## Key research findings

- **Mediabunny** ([github.com/Vanilagy/mediabunny](https://github.com/Vanilagy/mediabunny)) — pure-TS, zero-dep browser media toolkit over WebCodecs: demux/decode any common container, encode H.264/AAC with hardware acceleration, mux MP4. This is the export backbone; even Remotion is migrating to it.
- **OpenScreen** ([github.com/siddharthvaddem/openscreen](https://github.com/siddharthvaddem/openscreen), MIT, archived June 2026) — Electron Screen Studio clone with exactly our effect set: auto/manual zooms with depth/duration/easing, cursor smoothing, click effects, captions. Not reusable as an app (Electron), but its zoom-easing math, auto-zoom-from-click-telemetry logic, and effect implementations (PixiJS) are MIT-licensed and directly minable.
- **OpenCut** ([github.com/opencut-app/opencut](https://github.com/opencut-app/opencut)) — browser video editor; good reference for timeline UX and Zustand-based editor state, not a library we can drop in.
- **Remotion** — best DX but $25/seat / $100+/mo for companies beyond ~3 people; ruled out.
- **Browser constraint (important)**: `getDisplayMedia` cannot see the cursor position of another window/screen — only pixels. True auto-zoom needs telemetry from the demoed page itself. Since our demos are web UIs (WordPress admin), the app `window.open()`s the demo page and a **bookmarklet/snippet** on that page streams `pointermove`/`click` events back via `postMessage` (cross-origin OK to `window.opener`). Uploaded or un-instrumented recordings fall back to manual zoom keyframes.

## Architecture

Single-page app, fully client-side (no server; files never leave the machine).

- **Stack**: Vite + React + TypeScript, Zustand for editor state, plain CSS or Tailwind.
- **Project model**: a serializable JSON document — source clips (as OPFS/IndexedDB blob refs), timeline (ordered clips with trim in/out, speed), effect tracks (zoom keyframes, click ripples, highlights, text/captions), canvas settings (aspect, background gradient/wallpaper, padding, corner radius, shadow), audio (mic track, music, ducking later).
- **Compositor** (`src/engine/`): pure function `(project, timeMs, sourceFrame) → canvas`. 2D canvas first (drawImage is GPU-accelerated); the pipeline: background → rounded-rect video frame with shadow → camera transform (zoom/pan with spring/cubic easing between keyframes) → overlays (click ripple, synthetic cursor, highlight box, text). Same code path drives preview and export.
- **Preview**: `<video>` element as the frame source, rAF loop through the compositor. Seek-accurate enough for editing.
- **Export**: Mediabunny `Input` → decode frames → compositor on OffscreenCanvas → `VideoEncoder` (H.264) + audio passthrough/mix via Web Audio → Mediabunny MP4 `Output`. 1080p default, 4K option.
- **Recorder** (`src/recorder/`): `getDisplayMedia` + mic `getUserMedia` → MediaRecorder (webm) → import as clip. Telemetry: bookmarklet on the demoed page posts timestamped pointer/click events; recorder aligns them to recording start and stores them on the clip.
- **Auto-assist** (`src/autozoom/`): from click telemetry, cluster clicks in space+time → generate zoom segments (zoom-in to cluster region ~1.5–2.5×, hold, ease out) as *editable* keyframes on the zoom track. Port the heuristics from OpenScreen's auto-zoom (MIT).

## Task list — milestones (each independently demoable)

- [ ] **M1 — Skeleton + import + styled preview**: Vite app; drop an MP4/webm in; canvas preview with background, padding, rounded corners, shadow; aspect-ratio presets (16:9, square, vertical).
- [ ] **M2 — Zoom engine**: zoom keyframe track; click-drag on the preview to define a zoom region; eased camera moves; scrubber.
- [ ] **M3 — Timeline editor**: multi-clip timeline: reorder, trim, split, per-clip speed; zoom/effect segments rendered as blocks on tracks; keyboard shortcuts (space, arrows, s to split).
- [ ] **M4 — Export**: Mediabunny pipeline to MP4 with audio; progress UI. *Highest-risk milestone; spike right after M1 to de-risk WebCodecs/Mediabunny.*
- [ ] **M5 — In-app recorder + telemetry + auto-zoom**: record screen+mic, bookmarklet telemetry, auto-generated zoom keyframes, click-ripple overlay.
- [ ] **M6 — Polish pass**: text/caption overlays, background music with fade, highlight/spotlight effect, synthetic smoothed cursor (needs recording with `cursor: "never"` constraint where supported), project save/load as `.json` + media in OPFS.

## Verification

- After each milestone: run `npm run dev`, exercise the flow in Chrome (WebCodecs support is best there; internal tool can be Chrome-first).
- M4 acceptance: import a real ~1-min screen recording, add two zooms, export MP4; verify it plays in QuickTime/VLC and audio stays in sync.
- M5 acceptance: record a WordPress-admin demo with the bookmarklet active; confirm auto-zoom segments land on the actual click locations.

## Non-goals for v1

Multi-user/auth, server rendering, Safari/Firefox support guarantees, motion blur, AI-driven narrative editing (possible later: feed telemetry + transcript to Claude to propose cuts/pacing).
