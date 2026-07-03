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

## Export spike (M4 de-risk, done between M1 and M2)

- Session 2026-07-03 (part 1) ended mid-verification (laptop battery); resumed and finished same day.
- `src/engine/export.ts`: Mediabunny pipeline — BlobSource input → VideoSampleSink decode → shared `renderFrame` compositor on OffscreenCanvas → CanvasSource H.264 encode → Mp4Output. Audio passthrough for the single-clip/untrimmed/speed-1 case; M4 adds decode/re-encode. `mediaBlobs` map in store keeps raw bytes outside serializable state (OPFS in M6).
- **Perf bug found & fixed**: `getSample(t)` per output frame re-decodes from the previous keyframe every call → ~1 fps export (unusably slow on long-GOP sources, which screen recordings are). Rewrote the frame loop to batch contiguous same-clip frame runs through `samplesAtTimestamps()` (decodes each packet once) → ~10 fps at 1080p in headless Chrome.
- **Muxer bug found & fixed**: AAC first-packet timestamp is slightly negative (encoder priming, e.g. −0.023s); Mp4 muxer throws on negative timestamps. Pump now shifts the whole audio stream so it starts at 0, preserving packet spacing.
- Verified: `scripts/verify-export.mjs` (import clip → click Export → capture download → ffprobe): mp4 container, h264 1920×1080, aac audio, duration ≈5s; extracted mid-video frame shows correct composite and exact frame timing (burnt-in timecode matches).
- Test clips: generate with `ffmpeg -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=5" -f lavfi -i "sine=frequency=440:duration=5" -c:v libx264 -pix_fmt yuv420p -c:a aac out.mp4` (audio needed — verify-export asserts an aac track).
- Conclusion: WebCodecs/Mediabunny path de-risked; M4 risk retired. Next: M2 (zoom engine UI).

## M2 — Zoom engine UI

- Process note (per William, 2026-07-03): no more headless-Chrome/export test runs from the main session (token cost); William tests in his browser against the dev server. Component chunks delegated to parallel sonnet subagents; main session does store contract, integration glue, review, and tsc/vite build only.
- Store: `addZoom`/`updateZoom`/`removeZoom` + `selectedZoomId`; `seekRequest`/`requestSeek` one-shot so scrubber/overlay can seek without owning the `<video>` (Preview consumes+clears it).
- `TimelinePanel.tsx/.css` (subagent): ruler with adaptive mm:ss ticks + drag-to-scrub, playhead, zoom track (blocks drag-to-move, edge-resize with min-duration/ramp clamping), inspector (zoom 1.2–4×, ramp slider, delete), Space=play/pause + Delete=remove-selected keyboard handling.
- `ZoomOverlay.tsx/.css` (subagent): marquee drag on the preview frame → ZoomSegment at playhead (zoom from marquee size clamped 1.2–4×, center mapped through current camera crop so it's correct mid-zoom; 2s default duration, 500ms ramp); after adding, pauses and seeks to segment midpoint so the pose is visible. Overlay is a pointer-events:none cover with a hitzone sized to the frame rect (ResizeObserver) so playback controls stay clickable.
- Review fixes on subagent output: side effects (addZoom/seek) were inside a `setDrag` updater — StrictMode double-invokes updaters, would add every zoom twice in dev; moved out. Space keydown also skipped for focused buttons to avoid double-toggle.
- Build (tsc strict + vite) passes. Human pass done: William tested in browser, confirmed working.

## M2 follow-ups from William's testing (all committed, human-confirmed except the last)

- `+ Zoom` button in timeline panel: drops centered 2× segment at playhead, selects, pauses. Aligned with the track row (`.tp-actions::before` mirrors ruler height).
- Drag-to-create on empty track space: ghost block preview, either direction, <150ms drag = deselect click. Blocks' own drags unaffected (empty-space check via `e.target === e.currentTarget`).
- Selected zoom shows its target region as a dashed box on the preview (mapped through the live camera crop, clipped to frame via hitzone `overflow: hidden`).
- Inspector was clipping below the 110px panel (vertical stack) → horizontal row layout, 380px wide.
- Region box is editable: body-drag moves cx/cy, corner handles resize (zoom recomputed anchored to opposite corner, clamp 1.2–4×), Escape reverts. Geometry frozen at drag start to avoid feedback when editing the camera-driving segment. **Not yet human-tested.**

## Handoff notes (context cleared 2026-07-03; read this first)

**State:** M1 + M2 complete and committed on `main` (through `212d4d4`); export spike done. Working tree clean. Dev server from the old session is dead — just run `npm run dev`.

**Next up: M3 — timeline editor** (multi-clip: reorder/trim/split/speed, clip blocks on the track, `s` to split, arrow-key nudge). The store/timeline model already supports multi-clip (`clipAt`, `clipDurationMs` handle trim + speed); Preview does NOT — it binds only `project.timeline[0]`'s source and equates video time with timeline time (`Preview.tsx`), so M3 needs a preview playback controller that follows `clipAt()` across clips/trims/speeds. Export already walks the timeline correctly via `clipAt`, but audio passthrough bails to video-only for anything but 1 untrimmed speed-1 clip (`prepareAudioPassthrough` — M4 finishes that).

**Workflow constraints (from William, binding):**
- No headless-Chrome/export verification runs from the main session — too many tokens. `npm run build` (tsc strict + vite) is the only self-check; William tests flows in his own browser and reports back.
- Delegate parallelizable component chunks to **sonnet subagents** (parallel, non-overlapping files, they must not run builds); main session owns store contract, integration, review of subagent output (StrictMode purity, store misuse), commits.
- Commit granularly as things land. `.idea/` is gitignored.

**Needed from William (flagged earlier, still open):**
- Human test of the new move/resize region box on the preview.
- Eventually (M4 acceptance): a real ~1-min screen recording to export, checked in QuickTime/VLC for playback + A/V sync.
- M5 will need a human pass on `getDisplayMedia` recording + the telemetry bookmarklet on a WordPress admin page.

**Gotchas for the next session:**
- `verify-export.mjs`/`verify-m1.mjs` exist and work (need an ffmpeg test clip with an audio track — command in the export-spike section) but are OFF-LIMITS to run yourself unless William asks.
- Mediabunny decode: never `getSample()` per frame (O(frames×GOP)); use `samplesAtTimestamps()`/`samples()` iterators (see export.ts frame loop).
- MP4 muxer rejects negative timestamps; AAC passthrough shifts the stream (see `prepareAudioPassthrough` pump).
- Seeking goes through the store's one-shot `seekRequest` (Preview owns the `<video>`); don't add a second seek path.
