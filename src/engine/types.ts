/**
 * Project document model. Everything here must stay JSON-serializable
 * (blob URLs are session-transient; M6 swaps them for OPFS refs on save).
 */

export type Background =
  | { type: 'gradient'; from: string; to: string; angle: number }
  | { type: 'solid'; color: string }
  /** Current video frame, scaled to cover and blurred. blurPx 20–120, brightness 0.4–1. */
  | { type: 'frame-blur'; blurPx: number; brightness: number }
  /** Bitmap looked up in the `backgroundImages` registry (see engine/assets.ts). */
  | { type: 'image'; imageId: string };

export type ChromeStyle = 'none' | 'mac' | 'browser' | 'phone';

export interface FrameChrome {
  style: ChromeStyle;
  /** Text shown in the browser chrome's URL pill; hidden when empty. */
  urlText?: string;
}

export interface FrameShadow {
  blur: number;
  offsetY: number;
  opacity: number;
}

export interface CanvasSettings {
  width: number;
  height: number;
  background: Background;
  /** Padding around the video frame, as a fraction of the shorter canvas edge (0–0.4). */
  padding: number;
  /** Corner radius of the video frame in output pixels. */
  cornerRadius: number;
  shadow: FrameShadow;
  /** driftPct given to newly created zoom segments (0 disables). */
  defaultDriftPct: number;
  chrome: FrameChrome;
  /** Edge-darkening opacity while zoomed (0–0.4, 0 disables). */
  zoomVignette: number;
  /** Draw expanding rings at telemetry click positions. */
  clickRipples: boolean;
  /** Draw a smoothed synthetic cursor from pointer telemetry. */
  syntheticCursor: boolean;
}

export interface CaptionSegment {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
}

export interface MusicTrack {
  /** Key into mediaBlobs (and OPFS) for the audio file. */
  blobId: string;
  name: string;
  /** Linear gain 0–1. */
  gain: number;
  fadeInMs: number;
  fadeOutMs: number;
}

export interface PointerSample {
  /** ms from recording start */
  t: number;
  /** normalized 0–1 within the captured surface */
  x: number;
  y: number;
  kind: 'move' | 'click';
}

export interface SourceClip {
  id: string;
  name: string;
  /** Object URL for this session; replaced by OPFS ref on save/load (M6). */
  url: string;
  durationMs: number;
  width: number;
  height: number;
  telemetry?: PointerSample[];
}

export type TransitionType = 'dip-scale' | 'dip-fade';

export interface ClipTransition {
  type: TransitionType;
  /** Total transition duration, split evenly across the boundary. */
  durationMs: number;
}

export interface TitleCard {
  heading: string;
  sub?: string;
  durationMs: number;
}

export interface TimelineClip {
  id: string;
  /** null ⇒ title card (see `card`) — no source media. */
  sourceId: string | null;
  /** Trim window within the source, in source-time ms. */
  inMs: number;
  outMs: number;
  speed: number;
  card?: TitleCard;
  /** Dip transition covering the boundary AFTER this clip. */
  transitionOut?: ClipTransition;
}

/**
 * A camera move: ease in to a region, hold, ease out back to full frame.
 * Region is normalized (0–1) in source-video space; zoom is the scale factor.
 */
export interface ZoomSegment {
  id: string;
  /** Timeline time the ease-in starts. */
  startMs: number;
  /** Timeline time the ease-out completes. */
  endMs: number;
  /** Duration of ease-in and ease-out ramps within [startMs, endMs]. */
  rampMs: number;
  /** Center of the zoom target, normalized in video space. */
  cx: number;
  cy: number;
  zoom: number;
  /** Extra zoom applied linearly across the hold (Ken Burns drift), 0–0.08. */
  driftPct?: number;
}

export interface Project {
  canvas: CanvasSettings;
  sources: Record<string, SourceClip>;
  timeline: TimelineClip[];
  zooms: ZoomSegment[];
  captions: CaptionSegment[];
  music?: MusicTrack;
}

export interface AspectPreset {
  name: string;
  width: number;
  height: number;
}

export const ASPECT_PRESETS: AspectPreset[] = [
  { name: '16:9', width: 1920, height: 1080 },
  { name: 'Square', width: 1080, height: 1080 },
  { name: 'Vertical', width: 1080, height: 1920 },
];

export const BACKGROUND_PRESETS: { name: string; bg: Background }[] = [
  { name: 'Dusk', bg: { type: 'gradient', from: '#3b2667', to: '#bc78ec', angle: 135 } },
  { name: 'Ocean', bg: { type: 'gradient', from: '#0f2027', to: '#2c5364', angle: 135 } },
  { name: 'Sunset', bg: { type: 'gradient', from: '#f83600', to: '#f9d423', angle: 135 } },
  { name: 'Forest', bg: { type: 'gradient', from: '#134e5e', to: '#71b280', angle: 135 } },
  { name: 'Slate', bg: { type: 'solid', color: '#1e2430' } },
  { name: 'Paper', bg: { type: 'solid', color: '#ece8e1' } },
];

export function defaultProject(): Project {
  return {
    canvas: {
      width: 1920,
      height: 1080,
      background: BACKGROUND_PRESETS[0].bg,
      padding: 0.06,
      cornerRadius: 16,
      shadow: { blur: 60, offsetY: 24, opacity: 0.45 },
      defaultDriftPct: 0,
      chrome: { style: 'none' },
      zoomVignette: 0,
      clickRipples: true,
      syntheticCursor: false,
    },
    sources: {},
    timeline: [],
    zooms: [],
    captions: [],
  };
}
