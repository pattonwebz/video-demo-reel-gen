import type { ZoomSegment } from './types';
import { clamp, cubicInOut, lerp } from './easing';

/** Camera pose in normalized video space. Identity = full frame. */
export interface CameraPose {
  cx: number;
  cy: number;
  zoom: number;
}

export const IDENTITY_POSE: CameraPose = { cx: 0.5, cy: 0.5, zoom: 1 };

/**
 * Segments whose gap is at most this chain into one continuous move: the
 * camera travels directly between regions instead of returning to full frame.
 */
export const CHAIN_GAP_MS = 120;

/** A compiled camera path keyframe. `easing` applies to the span that ENDS here. */
export interface CameraKeyframe {
  t: number;
  pose: CameraPose;
  easing: 'cubic' | 'linear';
}

/** Pose at the end of the hold: the target plus any Ken Burns drift. */
function driftedPose(seg: ZoomSegment): CameraPose {
  return { cx: seg.cx, cy: seg.cy, zoom: seg.zoom * (1 + (seg.driftPct ?? 0)) };
}

/**
 * Compile zoom segments into pose keyframes. Isolated segments render
 * identically to the old per-segment easing (cubicInOut is symmetric, so
 * ramp-out as an eased target→identity span matches the old identity-lerp).
 * Overlaps (the UI prevents them) are resolved by truncating the earlier
 * segment, which makes the pair chained.
 */
export function compileCamera(zooms: ZoomSegment[]): CameraKeyframe[] {
  const segs = zooms
    .filter((z) => z.endMs > z.startMs)
    .sort((a, b) => a.startMs - b.startMs)
    .map((z) => ({ ...z }));
  for (let i = 0; i < segs.length - 1; i++) {
    if (segs[i].endMs > segs[i + 1].startMs) segs[i].endMs = segs[i + 1].startMs;
  }

  const kfs: CameraKeyframe[] = [];
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg.endMs <= seg.startMs) continue; // swallowed by an overlap truncation
    const next: ZoomSegment | undefined = segs[i + 1];
    const chainedPrev = kfs.length > 0 && seg.startMs - kfs[kfs.length - 1].t <= CHAIN_GAP_MS;
    const chainedNext = next !== undefined && next.startMs - seg.endMs <= CHAIN_GAP_MS;
    const ramp = Math.min(seg.rampMs, (seg.endMs - seg.startMs) / 2);

    if (!chainedPrev) kfs.push({ t: seg.startMs, pose: IDENTITY_POSE, easing: 'linear' });
    kfs.push({ t: seg.startMs + ramp, pose: { cx: seg.cx, cy: seg.cy, zoom: seg.zoom }, easing: 'cubic' });
    // Hold (with drift) runs to the ramp-out — or through the gap to the next
    // segment's start when chained, in which case the ramp-out is skipped and
    // the next segment's ramp-in travels pose-to-pose.
    const holdEnd = chainedNext ? next.startMs : seg.endMs - ramp;
    kfs.push({ t: holdEnd, pose: driftedPose(seg), easing: 'linear' });
    if (!chainedNext) kfs.push({ t: seg.endMs, pose: IDENTITY_POSE, easing: 'cubic' });
  }
  return kfs;
}

/** Compiled paths keyed by the zooms array identity (store replaces it on every edit). */
const compileCache = new WeakMap<ZoomSegment[], CameraKeyframe[]>();

/** Resolve the camera pose at a timeline time. */
export function cameraAt(zooms: ZoomSegment[], timeMs: number): CameraPose {
  let kfs = compileCache.get(zooms);
  if (!kfs) {
    kfs = compileCamera(zooms);
    compileCache.set(zooms, kfs);
  }
  if (kfs.length === 0 || timeMs <= kfs[0].t) return kfs[0]?.pose ?? IDENTITY_POSE;
  const last = kfs[kfs.length - 1];
  if (timeMs >= last.t) return last.pose;

  let lo = 0;
  let hi = kfs.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (kfs[mid].t <= timeMs) lo = mid;
    else hi = mid;
  }
  const a = kfs[lo];
  const b = kfs[hi];
  const dt = b.t - a.t;
  let u = dt > 0 ? (timeMs - a.t) / dt : 1;
  if (b.easing === 'cubic') u = cubicInOut(u);
  return {
    cx: lerp(a.pose.cx, b.pose.cx, u),
    cy: lerp(a.pose.cy, b.pose.cy, u),
    zoom: lerp(a.pose.zoom, b.pose.zoom, u),
  };
}

/**
 * Convert a camera pose to a source crop rect (in source pixels) that keeps
 * the crop fully inside the source frame.
 */
export function poseToSourceCrop(
  pose: CameraPose,
  srcW: number,
  srcH: number,
): { sx: number; sy: number; sw: number; sh: number } {
  const zoom = Math.max(1, pose.zoom);
  const sw = srcW / zoom;
  const sh = srcH / zoom;
  const sx = clamp(pose.cx * srcW - sw / 2, 0, srcW - sw);
  const sy = clamp(pose.cy * srcH - sh / 2, 0, srcH - sh);
  return { sx, sy, sw, sh };
}
