import { useEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useEditor } from '../state/store';
import { timelineDurationMs } from '../engine/timeline';
import type { ZoomSegment } from '../engine/types';
import './TimelinePanel.css';

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
    const rect = stripRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const x = clamp(clientX - rect.left, 0, rect.width);
    requestSeek((x / rect.width) * totalMs);
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

    if (drag.type === 'move') {
      const dur = drag.endMs - drag.startMs;
      const newStart = clamp(drag.startMs + deltaMs, 0, totalMs - dur);
      updateZoom(drag.id, { startMs: newStart, endMs: newStart + dur });
    } else if (drag.type === 'left') {
      const newStart = clamp(drag.startMs + deltaMs, 0, drag.endMs - minDur);
      const newDur = drag.endMs - newStart;
      const patch: ZoomPatch = { startMs: newStart };
      if (newDur < 2 * drag.rampMs) patch.rampMs = newDur / 2;
      updateZoom(drag.id, patch);
    } else {
      const newEnd = clamp(drag.endMs + deltaMs, drag.startMs + minDur, totalMs);
      const newDur = newEnd - drag.startMs;
      const patch: ZoomPatch = { endMs: newEnd };
      if (newDur < 2 * drag.rampMs) patch.rampMs = newDur / 2;
      updateZoom(drag.id, patch);
    }
  }

  function handleBlockPointerUp() {
    dragRef.current = null;
  }

  const tickInterval = pickTickIntervalMs(totalMs);
  const ticks: number[] = [];
  for (let t = 0; t <= totalMs; t += tickInterval) ticks.push(t);

  return (
    <div className="tp-panel">
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
        <div className="tp-track">
          {project.zooms.map((seg) => {
            const left = (seg.startMs / totalMs) * 100;
            const width = ((seg.endMs - seg.startMs) / totalMs) * 100;
            return (
              <div
                key={seg.id}
                className={`tp-zoom-block${seg.id === selectedZoomId ? ' selected' : ''}`}
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
        {selectedZoom ? (
          <>
            <label className="slider-label">
              Zoom {selectedZoom.zoom.toFixed(1)}×
              <input
                type="range"
                min={1.2}
                max={4}
                step={0.1}
                value={selectedZoom.zoom}
                onChange={(e) => updateZoom(selectedZoom.id, { zoom: Number(e.target.value) })}
              />
            </label>
            <label className="slider-label">
              Ramp {selectedZoom.rampMs}ms
              <input
                type="range"
                min={100}
                max={1500}
                step={50}
                value={selectedZoom.rampMs}
                onChange={(e) => {
                  const half = (selectedZoom.endMs - selectedZoom.startMs) / 2;
                  updateZoom(selectedZoom.id, { rampMs: Math.min(Number(e.target.value), half) });
                }}
              />
            </label>
            <button className="btn tp-delete-btn" onClick={() => removeZoom(selectedZoom.id)}>
              Delete
            </button>
          </>
        ) : (
          <p className="tp-hint">Drag on the preview to add a zoom</p>
        )}
      </aside>
    </div>
  );
}
