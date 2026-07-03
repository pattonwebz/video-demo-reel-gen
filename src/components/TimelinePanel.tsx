import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useEditor } from '../state/store';
import { timelineDurationMs } from '../engine/timeline';
import type { ZoomSegment } from '../engine/types';
import { CHAIN_GAP_MS } from '../engine/camera';
import './TimelinePanel.css';

/** Screen-pixel distance within which a dragged edge snaps to a neighbor's edge. */
const SNAP_PX = 8;

type ZoomPatch = Partial<Omit<ZoomSegment, 'id'>>;

interface DragState {
  type: 'move' | 'left' | 'right';
  id: string;
  startX: number;
  startMs: number;
  endMs: number;
  rampMs: number;
}

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

  const stripRef = useRef<HTMLDivElement | null>(null);
  const rulerDragging = useRef(false);
  const dragRef = useRef<DragState | null>(null);
  const [createDrag, setCreateDrag] = useState<{
    pointerId: number;
    anchorMs: number;
    curMs: number;
  } | null>(null);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (isEditableTarget(e.target)) return;
      const state = useEditor.getState();
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (state.selectedZoomId) state.removeZoom(state.selectedZoomId);
      } else if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        state.setPlaying(!state.playing);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const totalMs = timelineDurationMs(project);

  if (project.timeline.length === 0 || totalMs <= 0) return null;

  const { requestSeek, setSelectedZoom, updateZoom, removeZoom } = useEditor.getState();
  const selectedZoom = project.zooms.find((z) => z.id === selectedZoomId) ?? null;

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
        <div
          className="tp-playhead"
          style={{ left: `${clamp((currentTimeMs / totalMs) * 100, 0, 100)}%` }}
        />
      </div>
      <aside className="tp-inspector">
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
      </aside>
    </div>
  );
}
