import { useEffect, useRef, useState } from 'react';
import { exportProject } from '../engine/export';
import { mediaBlobs, useEditor } from '../state/store';

export default function ExportButton() {
  const hasClips = useEditor((s) => s.project.timeline.length > 0);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [scale, setScale] = useState<1 | 2>(1);
  const [fps, setFps] = useState<30 | 60>(30);
  const [motionBlur, setMotionBlur] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close the popover on any click/tap outside it.
  useEffect(() => {
    if (!settingsOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setSettingsOpen(false);
      }
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [settingsOpen]);

  const run = async () => {
    setSettingsOpen(false);
    setError(null);
    setProgress(0);
    try {
      const { project } = useEditor.getState();
      const blob = await exportProject(project, mediaBlobs, {
        fps,
        scale,
        motionBlur,
        onProgress: setProgress,
      });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'demo-reel.mp4';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      console.error('Export failed', e);
    } finally {
      setProgress(null);
    }
  };

  return (
    <div className="export-button-wrap" ref={wrapRef}>
      {error && <span className="export-error">{error}</span>}
      <button
        className="btn"
        disabled={!hasClips || progress !== null}
        data-testid="export-btn"
        onClick={() => setSettingsOpen((v) => !v)}
      >
        {progress === null ? 'Export MP4' : `Exporting ${Math.round(progress * 100)}%`}
      </button>
      {settingsOpen && progress === null && (
        <div className="export-popover" role="dialog" aria-label="Export settings">
          <div className="export-popover-header">
            <span>Export settings</span>
            <button
              type="button"
              className="export-popover-close"
              aria-label="Close export settings"
              onClick={() => setSettingsOpen(false)}
            >
              &times;
            </button>
          </div>

          <div className="export-popover-group">
            <span className="export-popover-label">Resolution</span>
            <div className="chip-row">
              <button
                type="button"
                className={`chip${scale === 1 ? ' active' : ''}`}
                onClick={() => setScale(1)}
              >
                1080p
              </button>
              <button
                type="button"
                className={`chip${scale === 2 ? ' active' : ''}`}
                onClick={() => setScale(2)}
              >
                4K
              </button>
            </div>
          </div>

          <div className="export-popover-group">
            <span className="export-popover-label">Frame rate</span>
            <div className="chip-row">
              <button
                type="button"
                className={`chip${fps === 30 ? ' active' : ''}`}
                onClick={() => setFps(30)}
              >
                30
              </button>
              <button
                type="button"
                className={`chip${fps === 60 ? ' active' : ''}`}
                onClick={() => setFps(60)}
              >
                60
              </button>
            </div>
          </div>

          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={motionBlur}
              onChange={(e) => setMotionBlur(e.target.checked)}
            />
            Motion blur <span className="hint">(fast zooms, export only)</span>
          </label>

          <div className="export-popover-actions">
            <button
              type="button"
              className="export-popover-cancel"
              onClick={() => setSettingsOpen(false)}
            >
              Cancel
            </button>
            <button type="button" className="btn" onClick={run}>
              Export
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
