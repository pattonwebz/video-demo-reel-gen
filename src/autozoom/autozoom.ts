import type { PointerSample, TimelineClip, ZoomSegment } from '../engine/types';
import { clamp } from '../engine/easing';

/** Clicks joining an existing cluster: at most this far apart in time… */
const CLUSTER_GAP_MS = 2500;
/** …and this far apart in normalized space from the cluster centroid. */
const CLUSTER_RADIUS = 0.3;

const LEAD_MS = 500; // ease in this long before the first click
const TAIL_MS = 1800; // hold this long after the last click
const ZOOM_LEVEL = 1.8;
const RAMP_MS = 500;

export type SuggestedZoom = Omit<ZoomSegment, 'id'>;

/**
 * Turn click telemetry into suggested zoom segments: clicks clustered in
 * space+time become one eased zoom onto the cluster centroid. Segments that
 * would collide are snapped start-to-end, which the camera compiler renders
 * as a direct pan between the regions. Everything returned is an ordinary
 * editable ZoomSegment — suggestions, not magic.
 */
export function suggestZoomsFromClicks(
  telemetry: PointerSample[],
  clip: TimelineClip,
  clipStartMs: number,
): SuggestedZoom[] {
  const clicks = telemetry
    .filter((s) => s.kind === 'click' && s.t >= clip.inMs && s.t <= clip.outMs)
    .sort((a, b) => a.t - b.t);
  if (clicks.length === 0) return [];

  // Cluster in source time/space.
  const clusters: PointerSample[][] = [];
  for (const click of clicks) {
    const cur = clusters[clusters.length - 1];
    if (cur) {
      const cx = cur.reduce((s, c) => s + c.x, 0) / cur.length;
      const cy = cur.reduce((s, c) => s + c.y, 0) / cur.length;
      const near = Math.hypot(click.x - cx, click.y - cy) <= CLUSTER_RADIUS;
      if (near && click.t - cur[cur.length - 1].t <= CLUSTER_GAP_MS) {
        cur.push(click);
        continue;
      }
    }
    clusters.push([click]);
  }

  const toTimeline = (sourceMs: number) => clipStartMs + (sourceMs - clip.inMs) / clip.speed;
  const clipEndMs = toTimeline(clip.outMs);

  const zooms: SuggestedZoom[] = [];
  for (const cluster of clusters) {
    const startMs = Math.max(clipStartMs, toTimeline(cluster[0].t) - LEAD_MS);
    const endMs = Math.min(clipEndMs, toTimeline(cluster[cluster.length - 1].t) + TAIL_MS);
    if (endMs - startMs < 600) continue;
    const seg: SuggestedZoom = {
      startMs,
      endMs,
      rampMs: RAMP_MS,
      cx: clamp(cluster.reduce((s, c) => s + c.x, 0) / cluster.length, 0, 1),
      cy: clamp(cluster.reduce((s, c) => s + c.y, 0) / cluster.length, 0, 1),
      zoom: ZOOM_LEVEL,
    };
    const prev = zooms[zooms.length - 1];
    if (prev && seg.startMs < prev.endMs) {
      // Collision: snap to the previous segment's end so the pans chain.
      seg.startMs = prev.endMs;
      if (seg.endMs - seg.startMs < 600) {
        prev.endMs = seg.endMs; // too short after snapping — extend prev instead
        continue;
      }
    }
    zooms.push(seg);
  }
  return zooms;
}
