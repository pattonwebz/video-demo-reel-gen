import { useEffect, useRef, useState } from 'react';
import { renderFrame } from '../engine/compositor';
import { importVideoFile, useEditor } from '../state/store';

/**
 * Live preview: a hidden <video> is the frame source; a rAF loop runs the
 * compositor into the visible canvas every frame so setting changes are
 * reflected immediately, playing or paused.
 */
export default function Preview() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const project = useEditor((s) => s.project);
  const playing = useEditor((s) => s.playing);
  const setPlaying = useEditor((s) => s.setPlaying);

  const firstClip = project.timeline[0];
  const source = firstClip ? project.sources[firstClip.sourceId] : null;

  // Keep the hidden video element bound to the active source.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !source) return;
    if (video.src !== source.url) {
      video.src = source.url;
      video.loop = true;
      video.muted = true; // preview audio comes later; muted allows autoplay
    }
  }, [source]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !source) return;
    if (playing) void video.play();
    else video.pause();
  }, [playing, source]);

  // Render loop. Reads the latest project from the store each frame so the
  // effect never needs to re-subscribe on project edits.
  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    const tick = () => {
      const { project: proj } = useEditor.getState();
      if (canvas.width !== proj.canvas.width) canvas.width = proj.canvas.width;
      if (canvas.height !== proj.canvas.height) canvas.height = proj.canvas.height;
      const hasFrame = video.readyState >= 2 && video.videoWidth > 0;
      const timeMs = video.currentTime * 1000;
      renderFrame(
        ctx,
        proj,
        timeMs,
        hasFrame ? { image: video, width: video.videoWidth, height: video.videoHeight } : null,
      );
      useEditor.getState().setCurrentTime(timeMs);
      raf = requestAnimationFrame(tick);
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
        const file = e.dataTransfer.files?.[0];
        if (file && file.type.startsWith('video/')) await importVideoFile(file);
      }}
    >
      <canvas ref={canvasRef} className="preview-canvas" data-testid="preview-canvas" />
      <video ref={videoRef} hidden playsInline />
      {!source && (
        <div className="drop-hint">
          <p>Drop an MP4 or WebM here</p>
          <p className="drop-hint-sub">or use “Import video” above</p>
        </div>
      )}
      {source && (
        <div className="preview-controls">
          <button className="btn" onClick={() => setPlaying(!playing)}>
            {playing ? 'Pause' : 'Play'}
          </button>
          <TimeReadout durationMs={source.durationMs} />
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
