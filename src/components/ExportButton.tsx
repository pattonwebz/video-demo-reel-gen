import { useState } from 'react';
import { exportProject } from '../engine/export';
import { mediaBlobs, useEditor } from '../state/store';

export default function ExportButton() {
  const hasClips = useEditor((s) => s.project.timeline.length > 0);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setError(null);
    setProgress(0);
    try {
      const { project } = useEditor.getState();
      const blob = await exportProject(project, mediaBlobs, {
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
    <>
      {error && <span className="export-error">{error}</span>}
      <button
        className="btn"
        disabled={!hasClips || progress !== null}
        data-testid="export-btn"
        onClick={run}
      >
        {progress === null ? 'Export MP4' : `Exporting ${Math.round(progress * 100)}%`}
      </button>
    </>
  );
}
