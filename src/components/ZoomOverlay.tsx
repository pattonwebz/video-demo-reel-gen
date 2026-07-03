import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent, RefObject } from 'react';
import { useEditor } from '../state/store';
import { contentRect } from '../engine/compositor';
import { cameraAt, poseToSourceCrop } from '../engine/camera';
import { clipAt, timelineDurationMs } from '../engine/timeline';
import { clamp } from '../engine/easing';
import type { Project, SourceClip, ZoomSegment } from '../engine/types';
import './ZoomOverlay.css';

interface ZoomOverlayProps {
  canvasRef: RefObject<HTMLCanvasElement | null>;
}

/** Active marquee drag, tracked in viewport (client) coordinates. */
interface DragState {
  pointerId: number;
  downX: number;
  downY: number;
  curX: number;
  curY: number;
}

/** Drags shorter than this in either axis (client px) are treated as a click, not a zoom. */
const CLICK_THRESHOLD_PX = 8;

/** Where the video frame currently sits, in both client px (for hit-testing/layout)
 * and canvas-internal px (for mapping into source-video space). */
interface FrameGeometry {
  canvas: HTMLCanvasElement;
  canvasRect: DOMRect;
  /** Frame rect in canvas-internal pixels (matches the compositor's contentRect). */
  frameRect: { x: number; y: number; w: number; h: number };
  /** Current camera crop, in source pixels. */
  crop: { sx: number; sy: number; sw: number; sh: number };
  srcW: number;
  srcH: number;
}

/** Resolves the source clip under the playhead, falling back to the first
 * timeline clip's source if the playhead is past the end (e.g. at a paused
 * boundary) so the overlay still has something to size against. */
function resolveActiveSource(project: Project, currentTimeMs: number): SourceClip | null {
  const hit = clipAt(project, currentTimeMs);
  if (hit) return hit.source;
  const first = project.timeline[0];
  return first ? (project.sources[first.sourceId] ?? null) : null;
}

function computeGeometry(
  canvas: HTMLCanvasElement,
  project: Project,
  currentTimeMs: number,
  source: SourceClip,
): FrameGeometry {
  const canvasRect = canvas.getBoundingClientRect();
  const frameRect = contentRect(project, source.width, source.height);
  const pose = cameraAt(project.zooms, currentTimeMs);
  const crop = poseToSourceCrop(pose, source.width, source.height);
  return { canvas, canvasRect, frameRect, crop, srcW: source.width, srcH: source.height };
}

/** Maps a viewport point to canvas-internal pixel coordinates. */
function clientToCanvasPx(clientX: number, clientY: number, geo: FrameGeometry): { x: number; y: number } {
  const { canvas, canvasRect } = geo;
  return {
    x: (clientX - canvasRect.left) * (canvas.width / canvasRect.width),
    y: (clientY - canvasRect.top) * (canvas.height / canvasRect.height),
  };
}

function insideFrame(pt: { x: number; y: number }, frameRect: FrameGeometry['frameRect']): boolean {
  return (
    pt.x >= frameRect.x &&
    pt.x <= frameRect.x + frameRect.w &&
    pt.y >= frameRect.y &&
    pt.y <= frameRect.y + frameRect.h
  );
}

/**
 * Drag-to-define-zoom interaction over the preview canvas. Renders a
 * click-through wrapper (so the rest of `.preview-area`, e.g. the playback
 * controls, stays interactive) plus a hit region sized to the visible video
 * frame where marquee drags are captured.
 */
export default function ZoomOverlay({ canvasRef }: ZoomOverlayProps) {
  const project = useEditor((s) => s.project);
  const currentTimeMs = useEditor((s) => s.currentTimeMs);
  const selectedZoomId = useEditor((s) => s.selectedZoomId);
  const addZoom = useEditor((s) => s.addZoom);
  const setPlaying = useEditor((s) => s.setPlaying);
  const requestSeek = useEditor((s) => s.requestSeek);

  const rootRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [frameBox, setFrameBox] = useState<{ left: number; top: number; width: number; height: number } | null>(
    null,
  );

  const hasTimeline = project.timeline.length > 0;
  const source = hasTimeline ? resolveActiveSource(project, currentTimeMs) : null;

  // Track the on-screen (client px) rect of the video frame so the hit
  // region's DOM box matches it. Deliberately keyed on source identity/canvas
  // settings rather than `currentTimeMs` — the frame's placement doesn't
  // change as the camera moves (only the crop drawn into it does), so this
  // avoids recomputing layout every animation frame.
  useEffect(() => {
    const canvas = canvasRef.current;
    const root = rootRef.current;
    if (!canvas || !root || !source) {
      setFrameBox(null);
      return;
    }

    const update = () => {
      const canvasRect = canvas.getBoundingClientRect();
      const rootRect = root.getBoundingClientRect();
      if (canvasRect.width === 0 || canvasRect.height === 0 || canvas.width === 0 || canvas.height === 0) return;
      const rect = contentRect(project, source.width, source.height);
      const scaleX = canvasRect.width / canvas.width;
      const scaleY = canvasRect.height / canvas.height;
      setFrameBox({
        left: canvasRect.left - rootRect.left + rect.x * scaleX,
        top: canvasRect.top - rootRect.top + rect.y * scaleY,
        width: rect.w * scaleX,
        height: rect.h * scaleY,
      });
    };

    update();
    const ro = new ResizeObserver(update);
    ro.observe(canvas);
    window.addEventListener('resize', update);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [canvasRef, source, project]);

  // Escape cancels an in-progress drag.
  useEffect(() => {
    if (!drag) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrag(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drag]);

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return; // primary button only
      const canvas = canvasRef.current;
      if (!canvas || !source) return;
      const geo = computeGeometry(canvas, project, currentTimeMs, source);
      const pt = clientToCanvasPx(e.clientX, e.clientY, geo);
      if (!insideFrame(pt, geo.frameRect)) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      setDrag({ pointerId: e.pointerId, downX: e.clientX, downY: e.clientY, curX: e.clientX, curY: e.clientY });
    },
    [canvasRef, project, currentTimeMs, source],
  );

  const handlePointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      setDrag((d) => (d && d.pointerId === e.pointerId ? { ...d, curX: e.clientX, curY: e.clientY } : d));
    },
    [],
  );

  /** Pointer capture lost / interaction interrupted: cancel without committing. */
  const handlePointerCancel = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    setDrag((d) => (d && d.pointerId === e.pointerId ? null : d));
  }, []);

  const finishDrag = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const d = drag;
      if (!d || d.pointerId !== e.pointerId) return;
      // Committing has side effects (store writes), so it must happen out here,
      // not in a setDrag updater — StrictMode double-invokes updaters.
      setDrag(null);

      const canvas = canvasRef.current;
      if (!canvas || !source) return;

      const dxClient = Math.abs(d.curX - d.downX);
      const dyClient = Math.abs(d.curY - d.downY);
      if (dxClient < CLICK_THRESHOLD_PX && dyClient < CLICK_THRESHOLD_PX) return; // click, not a drag

      const geo = computeGeometry(canvas, project, currentTimeMs, source);
      const { frameRect, crop, srcW, srcH } = geo;

      const p1 = clientToCanvasPx(d.downX, d.downY, geo);
      const p2 = clientToCanvasPx(d.curX, d.curY, geo);

      const x0 = clamp(Math.min(p1.x, p2.x), frameRect.x, frameRect.x + frameRect.w);
      const x1 = clamp(Math.max(p1.x, p2.x), frameRect.x, frameRect.x + frameRect.w);
      const y0 = clamp(Math.min(p1.y, p2.y), frameRect.y, frameRect.y + frameRect.h);
      const y1 = clamp(Math.max(p1.y, p2.y), frameRect.y, frameRect.y + frameRect.h);

      const marqueeW = x1 - x0;
      const marqueeH = y1 - y0;
      if (marqueeW <= 0 || marqueeH <= 0) return;

      const dragSw = (marqueeW / frameRect.w) * crop.sw;
      const dragSh = (marqueeH / frameRect.h) * crop.sh;
      if (dragSw <= 0 || dragSh <= 0) return;

      const zoom = clamp(Math.min(srcW / dragSw, srcH / dragSh), 1.2, 4);

      const centerX = (x0 + x1) / 2;
      const centerY = (y0 + y1) / 2;
      const sx = crop.sx + ((centerX - frameRect.x) / frameRect.w) * crop.sw;
      const sy = crop.sy + ((centerY - frameRect.y) / frameRect.h) * crop.sh;
      const cx = clamp(sx / srcW, 0, 1);
      const cy = clamp(sy / srcH, 0, 1);

      const totalDurMs = timelineDurationMs(project);
      let startMs = currentTimeMs;
      let durMs = Math.min(2000, totalDurMs - startMs);
      if (durMs < 600) {
        startMs = clamp(totalDurMs - 600, 0, startMs);
        durMs = Math.min(600, totalDurMs - startMs);
      }
      const endMs = startMs + durMs;
      const rampMs = Math.min(500, durMs / 3);

      const seg: Omit<ZoomSegment, 'id'> = { startMs, endMs, rampMs, cx, cy, zoom };
      addZoom(seg);
      setPlaying(false);
      // The segment holds its full zoom at mid-segment; jump the playhead
      // there so the new pose is immediately visible.
      requestSeek(startMs + durMs / 2);
    },
    [drag, canvasRef, project, currentTimeMs, source, addZoom, setPlaying, requestSeek],
  );

  if (!hasTimeline) return null;

  // Selected segment's target region in hitzone-local px: the segment's own
  // crop rect expressed relative to whatever crop the camera currently shows.
  const selectedSeg = selectedZoomId ? project.zooms.find((z) => z.id === selectedZoomId) : null;
  let selectionStyle: CSSProperties | null = null;
  if (selectedSeg && source && frameBox) {
    const crop = poseToSourceCrop(cameraAt(project.zooms, currentTimeMs), source.width, source.height);
    const target = poseToSourceCrop(
      { cx: selectedSeg.cx, cy: selectedSeg.cy, zoom: selectedSeg.zoom },
      source.width,
      source.height,
    );
    selectionStyle = {
      left: ((target.sx - crop.sx) / crop.sw) * frameBox.width,
      top: ((target.sy - crop.sy) / crop.sh) * frameBox.height,
      width: (target.sw / crop.sw) * frameBox.width,
      height: (target.sh / crop.sh) * frameBox.height,
    };
  }

  let marqueeStyle: CSSProperties | null = null;
  if (drag && rootRef.current) {
    const rootRect = rootRef.current.getBoundingClientRect();
    marqueeStyle = {
      left: Math.min(drag.downX, drag.curX) - rootRect.left,
      top: Math.min(drag.downY, drag.curY) - rootRect.top,
      width: Math.abs(drag.curX - drag.downX),
      height: Math.abs(drag.curY - drag.downY),
    };
  }

  return (
    <div ref={rootRef} className="zo-overlay">
      {frameBox && (
        <div
          className="zo-hitzone"
          style={{ left: frameBox.left, top: frameBox.top, width: frameBox.width, height: frameBox.height }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishDrag}
          onPointerCancel={handlePointerCancel}
        >
          {selectionStyle && selectedSeg && (
            <div className="zo-selection" style={selectionStyle}>
              <span className="zo-selection-label">{selectedSeg.zoom.toFixed(1)}×</span>
            </div>
          )}
        </div>
      )}
      {marqueeStyle && <div className="zo-marquee" style={marqueeStyle} />}
    </div>
  );
}
