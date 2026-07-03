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
 * How far into a zoom segment we are at time t: 0 at rest, 1 fully zoomed.
 * Eases in over rampMs, holds, eases out over the final rampMs.
 */
function segmentProgress(seg: ZoomSegment, timeMs: number): number {
  if (timeMs <= seg.startMs || timeMs >= seg.endMs) return 0;
  const ramp = Math.min(seg.rampMs, (seg.endMs - seg.startMs) / 2);
  if (timeMs < seg.startMs + ramp) return cubicInOut((timeMs - seg.startMs) / ramp);
  if (timeMs > seg.endMs - ramp) return cubicInOut((seg.endMs - timeMs) / ramp);
  return 1;
}

/**
 * Resolve the camera pose at a timeline time. Overlapping segments: the one
 * with the greatest progress wins (later segments take over as they ramp in).
 */
export function cameraAt(zooms: ZoomSegment[], timeMs: number): CameraPose {
  let best: { seg: ZoomSegment; p: number } | null = null;
  for (const seg of zooms) {
    const p = segmentProgress(seg, timeMs);
    if (p > 0 && (!best || p > best.p)) best = { seg, p };
  }
  if (!best) return IDENTITY_POSE;
  const { seg, p } = best;
  return {
    cx: lerp(0.5, seg.cx, p),
    cy: lerp(0.5, seg.cy, p),
    zoom: lerp(1, seg.zoom, p),
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
