# Demo Reel Studio 🎬

A **browser-based video editor** for creating polished demo reels with camera effects (zoom/pan), click highlights, captions, music, and styled backgrounds — exports as MP4 up to 4K. Runs **100% client-side** using WebCodecs and Mediabunny; your media never leaves your machine.

**Live app:** https://pattonwebz.github.io/video-demo-reel-gen/ (Chrome/Edge)

## Features

- ✅ **In-app screen recording**: Capture a tab/window/screen + microphone, with pointer telemetry from a bookmarklet on the demoed page
- ✅ **Auto-zoom**: Generate zoom segments automatically from recorded click clusters
- ✅ **Import videos**: Drop MP4 or WebM files (multiple at once)
- ✅ **Multi-clip timeline**: Reorder, trim, split, and per-clip speed (0.25–4×)
- ✅ **Zoom/pan effects**: Drag-to-define zoom regions, eased ramps, chained pans (snap two zooms together for a direct A→B pan), Ken Burns drift on holds
- ✅ **Styled canvas**: Solid/gradient/blur/image backgrounds, padding, corner radius, shadow, macOS/browser/phone window chrome, zoom vignette
- ✅ **Cuts & titles**: Dip-to-fade/scale transitions between clips, animated title cards
- ✅ **Click effects**: Click ripples and a smoothed synthetic cursor (driven by recorded telemetry)
- ✅ **Captions**: Lower-third caption track with its own timeline lane
- ✅ **Background music**: Import a track with volume and fade in/out (mixed into exports)
- ✅ **MP4 export**: H.264 + AAC, 1080p or 4K, 30/60 fps, optional motion blur on fast camera moves
- ✅ **Named projects**: Multiple projects saved locally in the browser (OPFS), auto-saved and restored on reload

## Stack

- **Frontend**: React 19, TypeScript, Vite
- **State**: Zustand
- **Media**: [Mediabunny](https://github.com/Vanilagy/mediabunny) (decode/encode/mux), WebCodecs API
- **Styling**: Plain CSS (dark theme)

## Quick Start

### Prerequisites
- Node.js 18+ and npm
- Chrome or Chromium-based browser (for WebCodecs support)

### Installation & Development

```bash
# Install dependencies
npm install

# Start dev server (http://localhost:5173)
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

## How to Use

### Record a demo (or import one)

1. Click **Record** in the top bar.
2. Enter your demo page's URL and click **Open** — it opens as a popup (this link is required for telemetry to reach the recorder).
3. Click **Copy bookmarklet**, then create a bookmark on your bookmarks bar and paste the copied code as its URL. On the demo page, click that bookmarklet — it streams pointer/click telemetry back to the studio.
4. Click **Start recording** and pick what to share. **Pick the demo page's tab** (not a window or full screen) for accurate click coordinates.
5. Do your demo, then stop via the Record button (or the browser's own "Stop sharing"). The recording imports itself into the timeline with its telemetry attached.

No telemetry needed? Just drop MP4/WebM files onto the preview, or use **Import**.

### Edit

- **Clips**: drag blocks on the clip track to reorder; drag edges to trim; **Split** button (or `S`) at the playhead; speed presets and delete in the clip inspector.
- **Zooms**: click **+ Zoom**, drag a marquee on the preview, or drag on empty zoom-track space. Adjust zoom (1.2–4×), ramp, and hold drift in the inspector; drag the dashed region box on the preview to retarget. Snap two zoom blocks together to chain them into one continuous pan.
- **Auto-zoom**: select a recorded clip and click **Auto-zoom** in its inspector — click clusters from telemetry become zoom segments (regions you've already zoomed are left alone).
- **Transitions & titles**: click the diamond between two clips to cycle none → fade → scale; **+ Title** adds an animated title card (edit heading/subheading/duration in its inspector).
- **Captions**: **+ Caption** adds a lower-third at the playhead; drag to move/resize on the caption track, edit text in the inspector.
- **Canvas & effects**: Settings panel — background (solid/gradient/blur/image), padding/radius/shadow, window chrome, zoom vignette, click ripples, smoothed cursor.
- **Music**: Settings panel → **Add music…**, then set volume and fades. *Music (and all audio) plays in exports only — the preview is silent.*

### Projects

The project menu next to the app title lets you rename the current project and create, switch, or delete projects. Everything (including media) is auto-saved to the browser's private storage (OPFS) and restored on reload. Storage is per-site and per-browser-profile — nothing is uploaded.

### Export

Click **Export** and choose resolution (1080p/4K), frame rate (30/60), and optional motion blur (applied to fast camera ramps, export-only). The MP4 (H.264 + AAC) downloads when encoding finishes.

### Keyboard Shortcuts

- **Space**: Play/pause
- **Delete/Backspace**: Remove selected zoom, clip, or caption
- **S**: Split the clip under the playhead
- **← / →**: Nudge selected clip trim by 100 ms (Shift: 1 s)
- **Escape**: Cancel a region-box edit / close popovers

## Project Status

All planned v1 milestones are complete:

- ✅ **M1**: Skeleton + import + styled preview
- ✅ **M2**: Zoom engine with visual editor
- ✅ **M3**: Multi-clip timeline editor (reorder/trim/split/speed)
- ✅ **M4**: Full export pipeline (multi-clip audio mix, 4K, 60 fps, motion blur)
- ✅ **M5**: In-app recorder + telemetry bookmarklet + auto-zoom + click ripples
- ✅ **M6**: Captions, music, smoothed cursor, named projects with OPFS persistence
- ✅ **Effects expansion**: chained pans, hold drift, frame-blur/image backgrounds, window chrome, vignette, dip transitions, title cards

Deferred: crossfade transitions (needs dual-clip decode), idle-time speed-up.

## Architecture

```
src/
├── main.tsx                    # Entry point (restores last project, starts autosave)
├── components/
│   ├── Preview.tsx             # Video preview + playback controller
│   ├── ZoomOverlay.tsx         # Marquee create + region-box editing on the preview
│   ├── TimelinePanel.tsx       # Ruler, playhead, clip/zoom/caption tracks, inspectors
│   ├── SettingsPanel.tsx       # Canvas styling, effects toggles, music
│   ├── RecordPanel.tsx         # Screen recording + telemetry bookmarklet
│   ├── ProjectMenu.tsx         # Named-project switcher (OPFS)
│   ├── ExportButton.tsx        # Export settings + MP4 export trigger
│   └── ImportButton.tsx        # Video file import
├── engine/
│   ├── compositor.ts           # Canvas rendering pipeline (preview + export)
│   ├── camera.ts               # Zoom/pan keyframe compiler + transform math
│   ├── easing.ts               # Easing functions
│   ├── export.ts               # Mediabunny MP4 export (video + audio mix)
│   ├── timeline.ts             # Timeline algebra (clips, trims, speeds, transitions)
│   ├── assets.ts               # Background image registry
│   └── types.ts                # Shared types
├── recorder/
│   ├── recorder.ts             # getDisplayMedia + mic capture, WebAudio mixdown
│   └── telemetry.ts            # Bookmarklet builder + postMessage receiver
├── autozoom/
│   └── autozoom.ts             # Click-cluster → zoom-segment heuristics
└── state/
    ├── store.ts                # Zustand editor state
    └── persist.ts              # OPFS multi-project save/load/autosave
```

### Key Design Decisions

- **Pure compositor**: `(project, timeMs, sourceFrame) → canvas`. Same code path drives preview and export — what you see is what you export.
- **Client-only**: No server, no authentication, no cloud storage. Your media never leaves your machine.
- **Mediabunny over Remotion**: Open-source media toolkit with full WebCodecs support; Remotion is cost-prohibitive for teams.
- **Bookmarklet telemetry**: Auto-zoom, click ripples, and the synthetic cursor need pointer data from the demoed page (e.g., a WordPress admin). A bookmarklet posts pointer/click events back to the recorder via `postMessage` — which is why the demo page must be opened from the Record panel.

## Browser Support

- **Chrome/Edge**: ✅ Full support (primary browser)
- **Safari/Firefox**: ⚠️ Limited or no WebCodecs support — not supported for v1

Requirements:
- WebCodecs API (`VideoEncoder`, `VideoDecoder`)
- OffscreenCanvas
- Web Audio API (audio mixdown)
- Origin Private File System (project persistence)

## Development

### Building & Testing
```bash
# Type check and build
npm run build
```

Development follows a strict TypeScript setup with incremental builds via `tsc -b`. Headless verification scripts live in `scripts/` (`verify.mjs`, `verify-m1.mjs`, `verify-export.mjs`) and drive the app in headless Chrome via playwright-core.

### Project State Model

The editor manages a serializable JSON project document:
- **Sources**: Imported/recorded videos, with optional pointer telemetry
- **Timeline**: Ordered clips (trim/speed/transition) and title cards
- **Zooms**: Camera segments (region, zoom, ramp, drift)
- **Captions & music**: Lower-third segments and a background track
- **Canvas settings**: Aspect, background, padding, chrome, effect toggles
- **Media blobs**: Raw bytes kept outside serializable state, mirrored to OPFS

### Export Pipeline

1. Input video is decoded via Mediabunny `VideoSampleSink`
2. Each frame is rendered through the compositor on OffscreenCanvas (with optional multi-sample motion blur)
3. Frames are H.264 encoded via `VideoEncoder`
4. Audio: passthrough for the trivial single-clip case; otherwise clips + music are scheduled into an `OfflineAudioContext` mix and AAC-encoded
5. Final MP4 is written to a Blob and offered as download

**Performance note**: Decoding is batched at the GOP level via `samplesAtTimestamps()` — never call `getSample()` per frame.

## Non-Goals (v1)

- Multi-user / authentication
- Server rendering
- Safari / Firefox support guarantees
- Motion blur in the *preview* (export-only)
- AI-driven narrative editing (possible in v2)

## License

MIT (compatible with Mediabunny's MPL-2.0)

## Acknowledgments

- [Mediabunny](https://github.com/Vanilagy/mediabunny) — browser media toolkit
- [OpenScreen](https://github.com/siddharthvaddem/openscreen) — reference for zoom/easing heuristics and click-ripple effects (MIT, archived)
- [OpenCut](https://github.com/opencut-app/opencut) — timeline UI inspiration

## Contributing

This is an internal tool. External contributions are not currently solicited, but bug reports and feature ideas via GitHub Issues are welcome.

## Known Limitations

- **Silent preview**: Clip audio and music play in exports only; the preview video is muted (autoplay requirement).
- **Telemetry accuracy**: Click coordinates are exact only when recording the demo page's *tab*; window/screen capture skews them. The demo page must be opened via the Record panel's popup for telemetry to arrive.
- **Speed-changed clips**: Export as silent (audio is not time-stretched).
- **Export speed**: Roughly ~10 fps at 1080p on typical hardware; 4K and motion blur are proportionally slower. WebCodecs performance varies by device.
- **Storage**: Projects live in the browser's OPFS — per-site, per-profile, and cleared if you wipe site data. There's no export/import of project files yet.

---

**Questions?** Open a [GitHub Issue](https://github.com/pattonwebz/video-demo-reel-gen/issues).
