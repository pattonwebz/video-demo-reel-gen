# Demo Reel Studio 🎬

A **browser-based video editor** for creating polished demo reels with camera effects (zoom/pan), click highlights, and styled backgrounds — exports as MP4. Runs **100% client-side** using WebCodecs and Mediabunny.

## Features

- ✅ **Import videos**: Drop an MP4 or WebM file to get started
- ✅ **Styled canvas preview**: Customize backgrounds, padding, corner radius, shadows, and aspect ratios (16:9, square, vertical)
- ✅ **Zoom/pan effects**: Add camera keyframes with easing curves; drag-to-define zoom regions on the preview
- ✅ **Visual timeline editor**: Scrubber, playback controls, editable zoom keyframes
- 🟡 **Multi-clip timeline**: Reorder, trim, split, and adjust per-clip speed (in progress)
- 🟡 **MP4 export**: Encode to H.264 with audio (single-clip support live, multi-clip in progress)
- 🟡 **In-app recording + auto-zoom**: Screen recording with click-telemetry-driven zoom suggestions (planned)
- 🟡 **Click overlays & captions**: Visual effects and text overlays (planned)

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

1. **Open the app** and drop an MP4 or WebM video file
2. **Adjust canvas settings** in the Settings panel (background, aspect ratio, padding, etc.)
3. **Add zoom effects**:
   - Click the **+ Zoom** button to add a centered 2× zoom at the current playhead
   - **Drag a marquee** on the preview to define a custom zoom region
   - Adjust the zoom level (1.2–4×), duration, and easing in the inspector
4. **Preview** as you go with the play/pause and timeline scrubber
5. **Export** as MP4 (File → Export)

### Keyboard Shortcuts
- **Space**: Play/pause
- **Delete**: Remove selected zoom
- **S**: Split zoom at playhead (coming soon)
- **Arrow keys**: Nudge playhead (coming soon)

## Project Status & Roadmap

Currently at **Milestone 2** of 6:
- ✅ **M1**: Skeleton + import + styled preview
- ✅ **M2**: Zoom engine with visual editor
- 🟡 **M3**: Multi-clip timeline editor
- 🟡 **M4**: MP4 export pipeline
- ⏳ **M5**: In-app recorder + auto-zoom from click telemetry
- ⏳ **M6**: Polish (captions, background music, smoothed cursor)

See [PLAN.md](./PLAN.md) for the full architecture and design decisions, and [PROGRESS.md](./PROGRESS.md) for detailed development notes.

## Architecture

```
src/
├── main.tsx                    # React entry point
├── components/
│   ├── Preview.tsx             # Video preview + zoom overlay
│   ├── TimelinePanel.tsx        # Ruler, playhead, zoom track, inspector
│   ├── SettingsPanel.tsx        # Canvas styling controls
│   ├── ExportButton.tsx         # MP4 export trigger
│   └── ImportButton.tsx         # Video file import
├── engine/
│   ├── compositor.ts            # Canvas rendering pipeline
│   ├── camera.ts                # Zoom/pan transform math
│   ├── easing.ts                # Cubic/spring easing functions
│   ├── export.ts                # Mediabunny MP4 export
│   ├── timeline.ts              # Project timeline algebra
│   └── types.ts                 # Shared types
└── state/
    └── store.ts                 # Zustand editor state
```

### Key Design Decisions

- **Pure compositor**: `(project, timeMs, sourceFrame) → canvas`. Same code path drives preview and export — what you see is what you export.
- **Client-only**: No server, no authentication, no cloud storage. Your media never leaves your machine.
- **Mediabunny over Remotion**: Open-source media toolkit with full WebCodecs support; Remotion is cost-prohibitive for teams.
- **Bookmarklet telemetry**: Auto-zoom requires telemetry from the demoed page (e.g., WordPress admin). A browser bookmarklet posts pointer/click events back to the recorder via `postMessage`.

## Browser Support

- **Chrome/Edge**: ✅ Full support (primary browser)
- **Safari/Firefox**: ⚠️ Limited or no WebCodecs support — not supported for v1

Requirements:
- WebCodecs API (`VideoEncoder`, `VideoDecoder`)
- OffscreenCanvas
- Web Audio API (for audio passthrough)

## Development

### Building & Testing
```bash
# Type check and build
npm run build

# Lint TypeScript
tsc -b
```

Development follows a strict TypeScript setup with incremental builds via `tsc -b`.

### Project State Model

The editor manages a serializable JSON project document:
- **Clips**: Source videos with optional in/out trim and playback speed
- **Timeline**: Ordered list of clips with timing metadata
- **Zoom keyframes**: Camera transforms (zoom, pan, easing, duration)
- **Canvas settings**: Aspect ratio, background, padding, shadows
- **Media blobs**: Raw video/audio bytes (stored separately, outside serializable state)

### Export Pipeline

1. Input video is decoded via Mediabunny `VideoSampleSink`
2. Each frame is rendered through the compositor on OffscreenCanvas
3. Frames are H.264 encoded via `VideoEncoder`
4. Audio is passthrough-muxed via Mediabunny `Mp4Output`
5. Final MP4 is written to a Blob and offered as download

**Performance note**: Decoding is batched at the GOP level via `samplesAtTimestamps()` — never call `getSample()` per frame.

## Non-Goals (v1)

- Multi-user / authentication
- Server rendering
- Safari / Firefox support guarantees
- Motion blur
- AI-driven narrative editing (possible in v2)
- Project save/load to persistent storage (OPFS in v2)

## License

MIT (compatible with Mediabunny's MPL-2.0)

## Acknowledgments

- [Mediabunny](https://github.com/Vanilagy/mediabunny) — browser media toolkit
- [OpenScreen](https://github.com/siddharthvaddem/openscreen) — reference for zoom/easing heuristics and click-ripple effects (MIT, archived)
- [OpenCut](https://github.com/opencut-app/opencut) — timeline UI inspiration

## Contributing

This is an internal tool. External contributions are not currently solicited, but bug reports and feature ideas via GitHub Issues are welcome.

## Known Limitations

- **Recording**: `getDisplayMedia()` cannot capture the cursor or click events automatically; the bookmarklet workaround requires an instrumented demo page.
- **Export speed**: Single-clip exports are ~10 fps at 1080p; full pipeline (multi-clip, audio re-encode) is being optimized in M4.
- **Audio**: Currently passthrough only (M4 adds decode/re-encode for trimmed clips and mixing).
- **Hardware acceleration**: WebCodecs performance varies by device; export may be slower on older hardware.

---

**Questions?** Open a [GitHub Issue](https://github.com/your-username/video-demo-reel-gen/issues).

