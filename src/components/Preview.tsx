import { useEffect, useRef, useState } from 'react';
import { renderFrame } from '../engine/compositor';
import { clipAt, timelineDurationMs } from '../engine/timeline';
import { importVideoFile, useEditor } from '../state/store';
import ZoomOverlay from './ZoomOverlay';

/** Ignore drift below this when deciding whether to re-seek the video element. */
const SEEK_SLACK_MS = 30;

interface PlaybackCtrl {
  /** Timeline position — the source of truth the video element follows. */
  timelineMs: number;
  /** Timeline clip the video element is currently serving. */
  boundClipId: string | null;
  /** Video element must be seeked to match timelineMs before it can advance us. */
  needsSeek: boolean;
  /** performance.now() of the previous tick — wall clock for sourceless (title-card) clips. */
  lastTickAt: number | null;
}

/**
 * Live preview: a hidden <video> is the frame source; a rAF loop runs the
 * compositor into the visible canvas every frame so setting changes are
 * reflected immediately, playing or paused.
 *
 * The rAF tick is also the playback controller: it maps timeline time to the
 * clip under the playhead via clipAt() (trim + speed aware), rebinds/seeks the
 * video element across clip boundaries, and lets the element drive the
 * timeline clock only while it is bound and in sync.
 */
export default function Preview() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const project = useEditor((s) => s.project);
  const playing = useEditor((s) => s.playing);
  const setPlaying = useEditor((s) => s.setPlaying);

  const hasTimeline = project.timeline.length > 0;
  const durationMs = timelineDurationMs(project);

  const ctrlRef = useRef<PlaybackCtrl>({
    timelineMs: useEditor.getState().currentTimeMs,
    boundClipId: null,
    needsSeek: true,
    lastTickAt: null,
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const state = useEditor.getState();
      const proj = state.project;
      const ctrl = ctrlRef.current;
      if (canvas.width !== proj.canvas.width) canvas.width = proj.canvas.width;
      if (canvas.height !== proj.canvas.height) canvas.height = proj.canvas.height;

      // Scrubber / zoom-placement seeks own the timeline position outright.
      if (state.seekRequest) {
        ctrl.timelineMs = state.seekRequest.ms;
        ctrl.needsSeek = true;
        state.clearSeekRequest();
      }

      const totalMs = timelineDurationMs(proj);
      if (ctrl.timelineMs >= totalMs && totalMs > 0) {
        // Reached the end: hold the last frame, stop playback.
        ctrl.timelineMs = Math.max(0, totalMs - 1);
        ctrl.needsSeek = true;
        if (state.playing) state.setPlaying(false);
      }
      ctrl.timelineMs = Math.max(0, ctrl.timelineMs);

      const now = performance.now();
      const wallDtMs = ctrl.lastTickAt === null ? 0 : now - ctrl.lastTickAt;
      ctrl.lastTickAt = now;

      const hit = clipAt(proj, ctrl.timelineMs);
      if (hit) {
        if (ctrl.boundClipId !== hit.clip.id) {
          ctrl.boundClipId = hit.clip.id;
          ctrl.needsSeek = true;
        }
        const source = hit.source;
        if (source === null) {
          // Title card: no media to serve; the wall clock advances the timeline.
          if (!video.paused) video.pause();
          if (state.playing) ctrl.timelineMs += wallDtMs;
        } else {
          if (video.src !== source.url) {
            video.src = source.url;
            video.muted = true; // preview audio comes later; muted allows autoplay
            ctrl.needsSeek = true;
          }
          if (video.playbackRate !== hit.clip.speed) video.playbackRate = hit.clip.speed;

          if (ctrl.needsSeek && video.readyState >= 1) {
            if (Math.abs(video.currentTime * 1000 - hit.sourceTimeMs) > SEEK_SLACK_MS) {
              video.currentTime = hit.sourceTimeMs / 1000;
            }
            ctrl.needsSeek = false;
          }

          if (state.playing) {
            if (video.paused) video.play().catch(() => undefined);
            if (!ctrl.needsSeek) {
              const srcMs = video.currentTime * 1000;
              if (srcMs >= hit.clip.outMs) {
                // Ran off the trim window: hop to the next clip (or the end).
                ctrl.timelineMs = hit.clipStartMs + (hit.clip.outMs - hit.clip.inMs) / hit.clip.speed;
                ctrl.needsSeek = true;
              } else {
                ctrl.timelineMs = hit.clipStartMs + (srcMs - hit.clip.inMs) / hit.clip.speed;
              }
            }
          } else if (!video.paused) {
            video.pause();
          }
        }
      } else if (!video.paused) {
        video.pause();
      }

      const boundToHit = hit !== null && hit.source !== null && !ctrl.needsSeek && video.src === hit.source.url;
      const hasFrame = boundToHit && video.readyState >= 2 && video.videoWidth > 0;
      renderFrame(
        ctx,
        proj,
        ctrl.timelineMs,
        hasFrame ? { image: video, width: video.videoWidth, height: video.videoHeight } : null,
      );
      if (state.currentTimeMs !== ctrl.timelineMs) state.setCurrentTime(ctrl.timelineMs);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      className={`preview-area${dragOver ? ' drag-over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={async (e) => {
        e.preventDefault();
        setDragOver(false);
        for (const file of Array.from(e.dataTransfer.files ?? [])) {
          if (file.type.startsWith('video/')) await importVideoFile(file);
        }
      }}
    >
      <canvas ref={canvasRef} className="preview-canvas" data-testid="preview-canvas" />
      <video ref={videoRef} hidden playsInline />
      <ZoomOverlay canvasRef={canvasRef} />
      {!hasTimeline && (
        <div className="drop-hint">
          <p>Drop an MP4 or WebM here</p>
          <p className="drop-hint-sub">or use “Import video” above</p>
        </div>
      )}
      {hasTimeline && (
        <div className="preview-controls">
          <button className="btn" onClick={() => setPlaying(!playing)}>
            {playing ? 'Pause' : 'Play'}
          </button>
          <TimeReadout durationMs={durationMs} />
        </div>
      )}
    </div>
  );
}

function TimeReadout({ durationMs }: { durationMs: number }) {
  const currentTimeMs = useEditor((s) => s.currentTimeMs);
  const fmt = (ms: number) => {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  return (
    <span className="time-readout">
      {fmt(currentTimeMs)} / {fmt(durationMs)}
    </span>
  );
}
