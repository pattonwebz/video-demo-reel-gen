import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useEditor } from '../state/store';
import { clipDurationMs, timelineDurationMs } from '../engine/timeline';
import type { CaptionSegment, TimelineClip, ZoomSegment } from '../engine/types';
import { CHAIN_GAP_MS } from '../engine/camera';
import './TimelinePanel.css';

/** Screen-pixel distance within which a dragged edge snaps to a neighbor's edge. */
const SNAP_PX = 8;

/** Screen-pixel distance a clip pointer must travel before a press counts as a reorder drag. */
const CLIP_DRAG_THRESHOLD_PX = 5;

/** Speed presets offered in the clip inspector. */
const SPEED_PRESETS = [0.5, 1, 1.5, 2, 3];

type ZoomPatch = Partial<Omit<ZoomSegment, 'id'>>;

interface DragState {
  type: 'move' | 'left' | 'right';
  id: string;
  startX: number;
  startMs: number;
  endMs: number;
  rampMs: number;
}

interface ClipDragState {
  type: 'move' | 'left' | 'right';
  id: string;
  startX: number;
  /** Set once the pointer has moved past the click/drag threshold. */
  moved: boolean;
  inMs: number;
  outMs: number;
  speed: number;
}

interface CaptionDragState {
  type: 'move' | 'left' | 'right';
  id: string;
  startX: number;
  startMs: number;
  endMs: number;
}

/** Minimum caption duration (ms) enforced while resizing. */
const CAPTION_MIN_DUR_MS = 300;

const TICK_STEPS_MS = [
  500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000, 900000, 1800000,
];

function pickTickIntervalMs(totalMs: number): number {
  for (const step of TICK_STEPS_MS) {
    if (totalMs / step <= 8) return step;
  }
  return TICK_STEPS_MS[TICK_STEPS_MS.length - 1];
}

function formatClock(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Snaps a single dragged edge (ms) to the nearest neighboring segment's edge within thresholdMs. */
function snapEdgeMs(
  zooms: ZoomSegment[],
  id: string,
  edgeMs: number,
  thresholdMs: number,
): number {
  let best = edgeMs;
  let bestDelta = thresholdMs;
  for (const z of zooms) {
    if (z.id === id) continue;
    const dStart = Math.abs(edgeMs - z.startMs);
    if (dStart <= bestDelta) {
      bestDelta = dStart;
      best = z.startMs;
    }
    const dEnd = Math.abs(edgeMs - z.endMs);
    if (dEnd <= bestDelta) {
      bestDelta = dEnd;
      best = z.endMs;
    }
  }
  return best;
}

/**
 * Snaps whichever edge of a moving block (start or end) is closer to a
 * neighbor's facing edge, returning the adjusted start that preserves duration.
 */
function snapMoveMs(
  zooms: ZoomSegment[],
  id: string,
  start: number,
  end: number,
  thresholdMs: number,
): number {
  const dur = end - start;
  let bestDelta = thresholdMs;
  let snappedStart = start;
  for (const z of zooms) {
    if (z.id === id) continue;
    // Moving block's left edge approaching a neighbor's right edge.
    const dStart = Math.abs(start - z.endMs);
    if (dStart <= bestDelta) {
      bestDelta = dStart;
      snappedStart = z.endMs;
    }
    // Moving block's right edge approaching a neighbor's left edge.
    const dEnd = Math.abs(end - z.startMs);
    if (dEnd <= bestDelta) {
      bestDelta = dEnd;
      snappedStart = z.startMs - dur;
    }
  }
  return snappedStart;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  // BUTTON included so Space activates the focused button instead of also toggling play.
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    tag === 'BUTTON' ||
    target.isContentEditable
  );
}

export default function TimelinePanel() {
  const project = useEditor((s) => s.project);
  const currentTimeMs = useEditor((s) => s.currentTimeMs);
  const selectedZoomId = useEditor((s) => s.selectedZoomId);
  const selectedClipId = useEditor((s) => s.selectedClipId);
  const selectedCaptionId = useEditor((s) => s.selectedCaptionId);

  const stripRef = useRef<HTMLDivElement | null>(null);
  const rulerDragging = useRef(false);
  const dragRef = useRef<DragState | null>(null);
  const clipDragRef = useRef<ClipDragState | null>(null);
  const captionDragRef = useRef<CaptionDragState | null>(null);
  const autoZoomFeedbackTimerRef = useRef<number | null>(null);
  const [createDrag, setCreateDrag] = useState<{
    pointerId: number;
    anchorMs: number;
    curMs: number;
  } | null>(null);
  const [autoZoomFeedback, setAutoZoomFeedback] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (autoZoomFeedbackTimerRef.current) clearTimeout(autoZoomFeedbackTimerRef.current);
    };
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (isEditableTarget(e.target)) return;
      const state = useEditor.getState();
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (state.selectedZoomId) state.removeZoom(state.selectedZoomId);
        else if (state.selectedClipId) state.removeClip(state.selectedClipId);
        else if (state.selectedCaptionId) state.removeCaption(state.selectedCaptionId);
      } else if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        state.setPlaying(!state.playing);
      } else if (e.key === 's' || e.key === 'S') {
        state.splitClipAt(state.currentTimeMs);
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const step = e.shiftKey ? 1000 : 100;
        const dir = e.key === 'ArrowLeft' ? -1 : 1;
        const total = timelineDurationMs(state.project);
        const next = clamp(state.currentTimeMs + dir * step, 0, total);
        state.requestSeek(next);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const totalMs = timelineDurationMs(project);

  if (project.timeline.length === 0 || totalMs <= 0) return null;

  const {
    requestSeek,
    setSelectedZoom,
    updateZoom,
    removeZoom,
    setSelectedClip,
    reorderClip,
    updateClip,
    removeClip,
    addTitleCard,
    updateCard,
    setClipTransition,
    updateCaption,
    removeCaption,
    setSelectedCaption,
  } = useEditor.getState();
  const selectedZoom = project.zooms.find((z) => z.id === selectedZoomId) ?? null;
  const selectedClip = project.timeline.find((c) => c.id === selectedClipId) ?? null;
  const selectedCaption = project.captions.find((c) => c.id === selectedCaptionId) ?? null;
  const selectedClipSource =
    selectedClip && selectedClip.sourceId ? project.sources[selectedClip.sourceId] : null;

  function seekFromClientX(clientX: number) {
    const t = timeFromClientX(clientX);
    if (t != null) requestSeek(t);
  }

  function handleRulerPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    rulerDragging.current = true;
    seekFromClientX(e.clientX);
  }
  function handleRulerPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!rulerDragging.current) return;
    seekFromClientX(e.clientX);
  }
  function handleRulerPointerUp() {
    rulerDragging.current = false;
  }

  function startBlockDrag(
    e: ReactPointerEvent<HTMLDivElement>,
    seg: ZoomSegment,
    type: DragState['type'],
  ) {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      type,
      id: seg.id,
      startX: e.clientX,
      startMs: seg.startMs,
      endMs: seg.endMs,
      rampMs: seg.rampMs,
    };
    setSelectedZoom(seg.id);
    setSelectedClip(null);
    setSelectedCaption(null);
  }

  function handleBlockPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    const rect = stripRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const pxPerMs = rect.width / totalMs;
    const deltaMs = (e.clientX - drag.startX) / pxPerMs;
    const minDur = Math.max(300, 2 * drag.rampMs);
    const snapThresholdMs = SNAP_PX / pxPerMs;
    const zooms = project.zooms;

    if (drag.type === 'move') {
      const dur = drag.endMs - drag.startMs;
      const rawStart = drag.startMs + deltaMs;
      const snappedStart = snapMoveMs(zooms, drag.id, rawStart, rawStart + dur, snapThresholdMs);
      const newStart = clamp(snappedStart, 0, totalMs - dur);
      updateZoom(drag.id, { startMs: newStart, endMs: newStart + dur });
    } else if (drag.type === 'left') {
      const rawStart = drag.startMs + deltaMs;
      const snappedStart = snapEdgeMs(zooms, drag.id, rawStart, snapThresholdMs);
      const newStart = clamp(snappedStart, 0, drag.endMs - minDur);
      const newDur = drag.endMs - newStart;
      const patch: ZoomPatch = { startMs: newStart };
      if (newDur < 2 * drag.rampMs) patch.rampMs = newDur / 2;
      updateZoom(drag.id, patch);
    } else {
      const rawEnd = drag.endMs + deltaMs;
      const snappedEnd = snapEdgeMs(zooms, drag.id, rawEnd, snapThresholdMs);
      const newEnd = clamp(snappedEnd, drag.startMs + minDur, totalMs);
      const newDur = newEnd - drag.startMs;
      const patch: ZoomPatch = { endMs: newEnd };
      if (newDur < 2 * drag.rampMs) patch.rampMs = newDur / 2;
      updateZoom(drag.id, patch);
    }
  }

  function handleBlockPointerUp() {
    dragRef.current = null;
  }

  function timeFromClientX(clientX: number): number | null {
    const rect = stripRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return null;
    return clamp(((clientX - rect.left) / rect.width) * totalMs, 0, totalMs);
  }

  // Dragging on empty track space sketches out a new zoom block.
  function handleTrackPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return; // blocks handle their own drags
    setSelectedZoom(null);
    setSelectedClip(null);
    setSelectedCaption(null);
    const t = timeFromClientX(e.clientX);
    if (t == null) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setCreateDrag({ pointerId: e.pointerId, anchorMs: t, curMs: t });
  }

  function handleTrackPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!createDrag || e.pointerId !== createDrag.pointerId) return;
    const t = timeFromClientX(e.clientX);
    if (t == null) return;
    setCreateDrag((d) => (d ? { ...d, curMs: t } : d));
  }

  function handleTrackPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (!createDrag || e.pointerId !== createDrag.pointerId) return;
    setCreateDrag(null);
    const startMs = Math.min(createDrag.anchorMs, createDrag.curMs);
    let endMs = Math.max(createDrag.anchorMs, createDrag.curMs);
    if (endMs - startMs < 150) return; // treat as a click (deselect already happened)
    endMs = Math.min(Math.max(endMs, startMs + 300), totalMs);

    // Check for overlapping zooms
    const overlaps = project.zooms.some((z) => startMs < z.endMs && z.startMs < endMs);
    if (overlaps) return; // don't create overlapping zoom

    const { addZoom, setPlaying } = useEditor.getState();
    addZoom({
      startMs,
      endMs,
      rampMs: Math.min(500, (endMs - startMs) / 3),
      cx: 0.5,
      cy: 0.5,
      zoom: 2,
    });
    setPlaying(false);
  }

  function handleTrackPointerCancel(e: ReactPointerEvent<HTMLDivElement>) {
    if (createDrag && e.pointerId === createDrag.pointerId) setCreateDrag(null);
  }

  function addZoomAtPlayhead() {
    const { addZoom, setPlaying, currentTimeMs: t } = useEditor.getState();
    let startMs = t;
    let durMs = Math.min(2000, totalMs - startMs);
    if (durMs < 600) {
      startMs = clamp(totalMs - 600, 0, startMs);
      durMs = Math.min(600, totalMs - startMs);
    }
    addZoom({
      startMs,
      endMs: startMs + durMs,
      rampMs: Math.min(500, durMs / 3),
      cx: 0.5,
      cy: 0.5,
      zoom: 2,
    });
    setPlaying(false);
    setSelectedCaption(null);
  }

  function addCaptionAtPlayhead() {
    const { addCaption, setPlaying, currentTimeMs: t } = useEditor.getState();
    // Pull back from the timeline end so a playhead parked there (end of
    // playback) still yields a visible, grabbable caption.
    const start = clamp(t, 0, Math.max(0, totalMs - 2000));
    addCaption({ startMs: start, endMs: Math.min(start + 2000, totalMs), text: 'Caption' });
    setPlaying(false);
  }

  function handleAutoZoom() {
    if (!selectedClipId) return;
    const n = useEditor.getState().autoZoomClip(selectedClipId);
    setAutoZoomFeedback(n > 0 ? `Added ${n} zoom${n === 1 ? '' : 's'}` : 'No new zooms');
    if (autoZoomFeedbackTimerRef.current) window.clearTimeout(autoZoomFeedbackTimerRef.current);
    autoZoomFeedbackTimerRef.current = window.setTimeout(() => setAutoZoomFeedback(null), 2000);
  }

  function splitAtPlayhead() {
    const { splitClipAt, currentTimeMs: t } = useEditor.getState();
    splitClipAt(t);
  }

  /** Cycles a clip's transitionOut: none -> dip-fade -> dip-scale -> none. */
  function cycleTransition(clip: TimelineClip) {
    const t = clip.transitionOut;
    if (!t) setClipTransition(clip.id, { type: 'dip-fade', durationMs: 400 });
    else if (t.type === 'dip-fade') setClipTransition(clip.id, { type: 'dip-scale', durationMs: 400 });
    else setClipTransition(clip.id, null);
  }

  // --- Clip track: positions, drag-to-reorder, edge trim ---

  let clipCursor = 0;
  const clipPositions = project.timeline.map((clip) => {
    const dur = clipDurationMs(clip);
    const startMs = clipCursor;
    clipCursor += dur;
    return { clip, startMs, durMs: dur };
  });

  /** Index (within project.timeline, post-removal ordering) the pointer is currently over. */
  function clipIndexAtClientX(clientX: number, draggedId: string): number {
    const rect = stripRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    const t = clamp(((clientX - rect.left) / rect.width) * totalMs, 0, totalMs);
    let cursor = 0;
    let idx = 0;
    for (const c of project.timeline) {
      if (c.id === draggedId) continue;
      const dur = clipDurationMs(c);
      const mid = cursor + dur / 2;
      if (t > mid) idx++;
      cursor += dur;
    }
    return idx;
  }

  function startClipDrag(
    e: ReactPointerEvent<HTMLDivElement>,
    clip: TimelineClip,
    type: ClipDragState['type'],
  ) {
    e.currentTarget.setPointerCapture(e.pointerId);
    clipDragRef.current = {
      type,
      id: clip.id,
      startX: e.clientX,
      moved: false,
      inMs: clip.inMs,
      outMs: clip.outMs,
      speed: clip.speed,
    };
    setSelectedClip(clip.id);
    setSelectedZoom(null);
    setSelectedCaption(null);
  }

  function handleClipPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const drag = clipDragRef.current;
    if (!drag) return;
    const rect = stripRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const pxPerMs = rect.width / totalMs;
    const dxPx = e.clientX - drag.startX;
    if (!drag.moved && Math.abs(dxPx) > CLIP_DRAG_THRESHOLD_PX) drag.moved = true;

    if (drag.type === 'move') {
      if (!drag.moved) return; // still within click tolerance; don't reorder yet
      const fromIndex = project.timeline.findIndex((c) => c.id === drag.id);
      if (fromIndex === -1) return;
      const targetIndex = clipIndexAtClientX(e.clientX, drag.id);
      if (targetIndex !== fromIndex) reorderClip(fromIndex, targetIndex);
      return;
    }

    // Trim: convert the pointer's timeline-ms delta to source ms via clip speed,
    // then let updateClip's own clamping handle bounds.
    const deltaTimelineMs = dxPx / pxPerMs;
    const deltaSourceMs = deltaTimelineMs * drag.speed;
    if (drag.type === 'left') {
      updateClip(drag.id, { inMs: drag.inMs + deltaSourceMs });
    } else {
      updateClip(drag.id, { outMs: drag.outMs + deltaSourceMs });
    }

    // Seek the preview to the edge being dragged, recomputed from the
    // post-update store (trimming can shift this clip's own start-relative duration).
    const updated = useEditor.getState().project;
    let cursor = 0;
    for (const c of updated.timeline) {
      if (c.id === drag.id) {
        const dur = clipDurationMs(c);
        requestSeek(drag.type === 'left' ? cursor : cursor + dur);
        break;
      }
      cursor += clipDurationMs(c);
    }
  }

  function handleClipPointerUp() {
    clipDragRef.current = null;
  }

  function handleClipTrackPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return; // clips handle their own drags
    setSelectedClip(null);
  }

  // --- Caption track: click to select, drag body/edges to move/resize ---

  function startCaptionDrag(
    e: ReactPointerEvent<HTMLDivElement>,
    seg: CaptionSegment,
    type: CaptionDragState['type'],
  ) {
    e.currentTarget.setPointerCapture(e.pointerId);
    captionDragRef.current = {
      type,
      id: seg.id,
      startX: e.clientX,
      startMs: seg.startMs,
      endMs: seg.endMs,
    };
    setSelectedCaption(seg.id);
    setSelectedZoom(null);
    setSelectedClip(null);
  }

  function handleCaptionPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const drag = captionDragRef.current;
    if (!drag) return;
    const rect = stripRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const pxPerMs = rect.width / totalMs;
    const deltaMs = (e.clientX - drag.startX) / pxPerMs;

    if (drag.type === 'move') {
      const dur = drag.endMs - drag.startMs;
      const rawStart = drag.startMs + deltaMs;
      const newStart = clamp(rawStart, 0, totalMs - dur);
      updateCaption(drag.id, { startMs: newStart, endMs: newStart + dur });
    } else if (drag.type === 'left') {
      const rawStart = drag.startMs + deltaMs;
      const newStart = clamp(rawStart, 0, drag.endMs - CAPTION_MIN_DUR_MS);
      updateCaption(drag.id, { startMs: newStart });
    } else {
      const rawEnd = drag.endMs + deltaMs;
      const newEnd = clamp(rawEnd, drag.startMs + CAPTION_MIN_DUR_MS, totalMs);
      updateCaption(drag.id, { endMs: newEnd });
    }
  }

  function handleCaptionPointerUp() {
    captionDragRef.current = null;
  }

  function handleCaptionTrackPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return; // caption blocks handle their own drags
    setSelectedCaption(null);
  }

  const tickInterval = pickTickIntervalMs(totalMs);
  const ticks: number[] = [];
  for (let t = 0; t <= totalMs; t += tickInterval) ticks.push(t);

  const selectedZoomDurationMs = selectedZoom ? selectedZoom.endMs - selectedZoom.startMs : 0;
  const rampMaxMs = selectedZoom ? Math.max(100, Math.min(1500, selectedZoomDurationMs / 2)) : 0;

  // Adjacent segments whose gap is within CHAIN_GAP_MS pan directly between
  // regions (see camera.ts). Mark the touching edges and draw a bridge so the
  // user can see the two blocks are linked.
  const chainedRightIds = new Set<string>();
  const chainedLeftIds = new Set<string>();
  const chainBridges: { key: string; atMs: number }[] = [];
  const sortedZooms = [...project.zooms].sort((a, b) => a.startMs - b.startMs);
  for (let i = 0; i < sortedZooms.length - 1; i++) {
    const a = sortedZooms[i];
    const b = sortedZooms[i + 1];
    if (b.startMs - a.endMs <= CHAIN_GAP_MS) {
      chainedRightIds.add(a.id);
      chainedLeftIds.add(b.id);
      chainBridges.push({ key: `${a.id}_${b.id}`, atMs: (a.endMs + b.startMs) / 2 });
    }
  }

  return (
    <div className="tp-panel">
      <div className="tp-actions">
        <button className="btn tp-add-btn" title="Add a zoom segment at the playhead" onClick={addZoomAtPlayhead}>
          + Zoom
        </button>
        <button
          className="btn tp-add-btn tp-add-title-btn"
          title="Add a title card at the end of the timeline"
          onClick={() => {
            addTitleCard();
            setSelectedCaption(null);
          }}
        >
          + Title
        </button>
        <button
          className="btn tp-add-btn tp-add-caption-btn"
          title="Add a caption at the playhead"
          onClick={addCaptionAtPlayhead}
        >
          + Caption
        </button>
        <button className="btn tp-split-btn" title="Split the clip under the playhead (S)" onClick={splitAtPlayhead}>
          Split
        </button>
      </div>
      <div className="tp-strip" ref={stripRef}>
        <div
          className="tp-ruler"
          onPointerDown={handleRulerPointerDown}
          onPointerMove={handleRulerPointerMove}
          onPointerUp={handleRulerPointerUp}
          onPointerCancel={handleRulerPointerUp}
        >
          {ticks.map((t) => (
            <div key={t} className="tp-tick" style={{ left: `${(t / totalMs) * 100}%` }}>
              <span className="tp-tick-label">{formatClock(t)}</span>
            </div>
          ))}
        </div>
        <div className="tp-clip-track" onPointerDown={handleClipTrackPointerDown}>
          {clipPositions.map(({ clip, startMs, durMs }) => {
            const left = (startMs / totalMs) * 100;
            const width = (durMs / totalMs) * 100;
            const isCard = clip.sourceId === null;
            const label =
              clip.sourceId === null
                ? `T · ${clip.card?.heading ?? 'Title'}`
                : (project.sources[clip.sourceId]?.name ?? 'Unknown');
            return (
              <div
                key={clip.id}
                className={`tp-clip-block${isCard ? ' tp-clip-card' : ''}${clip.id === selectedClipId ? ' selected' : ''}`}
                style={{ left: `${left}%`, width: `${width}%` }}
                onPointerDown={(e) => startClipDrag(e, clip, 'move')}
                onPointerMove={handleClipPointerMove}
                onPointerUp={handleClipPointerUp}
                onPointerCancel={handleClipPointerUp}
              >
                {!isCard && (
                  <div
                    className="tp-clip-handle tp-clip-handle-left"
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      startClipDrag(e, clip, 'left');
                    }}
                  />
                )}
                <span className="tp-clip-label">
                  {label}
                  {clip.speed !== 1 && <span className="tp-clip-speed-badge">{clip.speed}×</span>}
                </span>
                {!isCard && (
                  <div
                    className="tp-clip-handle tp-clip-handle-right"
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      startClipDrag(e, clip, 'right');
                    }}
                  />
                )}
              </div>
            );
          })}
          {clipPositions.slice(0, -1).map(({ clip }, i) => {
            const atMs = clipPositions[i + 1].startMs;
            const t = clip.transitionOut;
            const stateClass = t ? (t.type === 'dip-fade' ? ' fade' : ' scale') : '';
            const stateLabel = t ? (t.type === 'dip-fade' ? 'fade' : 'scale') : 'none';
            return (
              <button
                key={`junction_${clip.id}`}
                type="button"
                className={`tp-transition-junction${stateClass}`}
                style={{ left: `${(atMs / totalMs) * 100}%` }}
                title={`Transition: ${stateLabel} (click to change)`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  cycleTransition(clip);
                }}
              />
            );
          })}
        </div>
        <div
          className="tp-track"
          onPointerDown={handleTrackPointerDown}
          onPointerMove={handleTrackPointerMove}
          onPointerUp={handleTrackPointerUp}
          onPointerCancel={handleTrackPointerCancel}
        >
          {createDrag && (
            <div
              className="tp-zoom-ghost"
              style={{
                left: `${(Math.min(createDrag.anchorMs, createDrag.curMs) / totalMs) * 100}%`,
                width: `${(Math.abs(createDrag.curMs - createDrag.anchorMs) / totalMs) * 100}%`,
              }}
            />
          )}
          {chainBridges.map((b) => (
            <div
              key={b.key}
              className="tp-chain-bridge"
              style={{ left: `${(b.atMs / totalMs) * 100}%` }}
            />
          ))}
          {project.zooms.map((seg) => {
            const left = (seg.startMs / totalMs) * 100;
            const width = ((seg.endMs - seg.startMs) / totalMs) * 100;
            const chainClass =
              (chainedRightIds.has(seg.id) ? ' chain-right' : '') +
              (chainedLeftIds.has(seg.id) ? ' chain-left' : '');
            return (
              <div
                key={seg.id}
                className={`tp-zoom-block${seg.id === selectedZoomId ? ' selected' : ''}${chainClass}`}
                style={{ left: `${left}%`, width: `${width}%` }}
                onPointerDown={(e) => startBlockDrag(e, seg, 'move')}
                onPointerMove={handleBlockPointerMove}
                onPointerUp={handleBlockPointerUp}
                onPointerCancel={handleBlockPointerUp}
              >
                <div
                  className="tp-zoom-handle tp-zoom-handle-left"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    startBlockDrag(e, seg, 'left');
                  }}
                />
                <span className="tp-zoom-label">{seg.zoom.toFixed(1)}×</span>
                <div
                  className="tp-zoom-handle tp-zoom-handle-right"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    startBlockDrag(e, seg, 'right');
                  }}
                />
              </div>
            );
          })}
        </div>
        <div className="tp-caption-track" onPointerDown={handleCaptionTrackPointerDown}>
          {project.captions.map((seg) => {
            const left = (seg.startMs / totalMs) * 100;
            const width = ((seg.endMs - seg.startMs) / totalMs) * 100;
            return (
              <div
                key={seg.id}
                className={`tp-caption-block${seg.id === selectedCaptionId ? ' selected' : ''}`}
                style={{ left: `${left}%`, width: `${width}%` }}
                onPointerDown={(e) => startCaptionDrag(e, seg, 'move')}
                onPointerMove={handleCaptionPointerMove}
                onPointerUp={handleCaptionPointerUp}
                onPointerCancel={handleCaptionPointerUp}
              >
                <div
                  className="tp-caption-handle tp-caption-handle-left"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    startCaptionDrag(e, seg, 'left');
                  }}
                />
                <span className="tp-caption-label">{seg.text}</span>
                <div
                  className="tp-caption-handle tp-caption-handle-right"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    startCaptionDrag(e, seg, 'right');
                  }}
                />
              </div>
            );
          })}
        </div>
        <div
          className="tp-playhead"
          style={{ left: `${clamp((currentTimeMs / totalMs) * 100, 0, 100)}%` }}
        />
      </div>
      <aside className="tp-inspector">
        {selectedClip && selectedClip.sourceId === null && selectedClip.card ? (
          <>
            <input
              type="text"
              className="text-input tp-card-input"
              placeholder="Heading"
              value={selectedClip.card.heading}
              onChange={(e) => updateCard(selectedClip.id, { heading: e.target.value })}
            />
            <input
              type="text"
              className="text-input tp-card-input"
              placeholder="Subtitle (optional)"
              value={selectedClip.card.sub ?? ''}
              onChange={(e) => {
                const v = e.target.value;
                updateCard(selectedClip.id, { sub: v === '' ? undefined : v });
              }}
            />
            <label className="slider-label tp-card-duration">
              Duration {(selectedClip.card.durationMs / 1000).toFixed(1)}s
              <input
                type="range"
                min={500}
                max={10000}
                step={500}
                value={selectedClip.card.durationMs}
                onChange={(e) => updateCard(selectedClip.id, { durationMs: Number(e.target.value) })}
              />
            </label>
            <button
              type="button"
              className="btn tp-delete-btn"
              onClick={() => removeClip(selectedClip.id)}
            >
              Delete
            </button>
          </>
        ) : selectedClip ? (
          <>
            <div className="tp-speed-group">
              <span className="tp-speed-group-label">Speed</span>
              {SPEED_PRESETS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`tp-speed-btn${selectedClip.speed === s ? ' active' : ''}`}
                  onClick={() => updateClip(selectedClip.id, { speed: s })}
                >
                  {s}×
                </button>
              ))}
            </div>
            <span className="tp-hint tp-trim-readout">
              {formatClock(selectedClip.inMs)} – {formatClock(selectedClip.outMs)}
            </span>
            <button
              type="button"
              className="btn tp-autozoom-btn"
              disabled={!selectedClipSource?.telemetry?.length}
              title={
                selectedClipSource?.telemetry?.length
                  ? 'Generate zoom segments from this clip’s pointer telemetry'
                  : "No pointer telemetry on this clip's source"
              }
              onClick={handleAutoZoom}
            >
              Auto-zoom
            </button>
            {autoZoomFeedback && <span className="tp-hint tp-autozoom-feedback">{autoZoomFeedback}</span>}
            <button
              type="button"
              className="btn tp-delete-btn"
              onClick={() => removeClip(selectedClip.id)}
            >
              Delete
            </button>
          </>
        ) : selectedCaption ? (
          <>
            <input
              type="text"
              className="text-input tp-caption-input"
              placeholder="Caption text"
              value={selectedCaption.text}
              onChange={(e) => updateCaption(selectedCaption.id, { text: e.target.value })}
            />
            <span className="tp-hint tp-trim-readout">
              {formatClock(selectedCaption.startMs)} – {formatClock(selectedCaption.endMs)}
            </span>
            <button
              type="button"
              className="btn tp-delete-btn"
              onClick={() => removeCaption(selectedCaption.id)}
            >
              Delete
            </button>
          </>
        ) : (
          <>
            <label className="slider-label">
              Zoom {selectedZoom ? selectedZoom.zoom.toFixed(1) : '—'}×
              <input
                type="range"
                min={1.2}
                max={4}
                step={0.1}
                value={selectedZoom?.zoom ?? 1.2}
                disabled={!selectedZoom}
                onChange={(e) => selectedZoom && updateZoom(selectedZoom.id, { zoom: Number(e.target.value) })}
              />
            </label>
            <label className="slider-label">
              Ramp {selectedZoom ? selectedZoom.rampMs : '—'}ms
              <input
                type="range"
                min={100}
                max={rampMaxMs}
                step={50}
                value={selectedZoom ? Math.min(selectedZoom.rampMs, rampMaxMs) : 100}
                disabled={!selectedZoom}
                onChange={(e) => {
                  selectedZoom && updateZoom(selectedZoom.id, { rampMs: Math.min(Number(e.target.value), rampMaxMs) });
                }}
              />
            </label>
            <label className="slider-label">
              Drift {selectedZoom ? Math.round((selectedZoom.driftPct ?? 0) * 100) : '—'}%
              <input
                type="range"
                min={0}
                max={8}
                step={1}
                value={selectedZoom ? Math.round((selectedZoom.driftPct ?? 0) * 100) : 0}
                disabled={!selectedZoom}
                onChange={(e) => {
                  selectedZoom && updateZoom(selectedZoom.id, { driftPct: Number(e.target.value) / 100 });
                }}
              />
            </label>
            <button
              type="button"
              className="btn tp-delete-btn"
              disabled={!selectedZoom}
              onClick={() => selectedZoom && removeZoom(selectedZoom.id)}
            >
              Delete
            </button>
          </>
        )}
      </aside>
    </div>
  );
}
