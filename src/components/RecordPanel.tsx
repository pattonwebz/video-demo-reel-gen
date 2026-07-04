import { useEffect, useRef, useState } from 'react';
import { DemoRecorder } from '../recorder/recorder';
import { buildBookmarklet, openDemoPage } from '../recorder/telemetry';
import { importAndPersistVideoFile } from '../state/persist';
import './RecordPanel.css';

const DEMO_URL_KEY = 'rp-demo-url';

// One recorder instance for the component's lifetime — recreating it would
// drop in-flight MediaStreams/MediaRecorder state across StrictMode remounts.
const recorder = new DemoRecorder();

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const mm = Math.floor(totalSec / 60)
    .toString()
    .padStart(2, '0');
  const ss = (totalSec % 60).toString().padStart(2, '0');
  return `${mm}:${ss}`;
}

export default function RecordPanel() {
  const [open, setOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [importing, setImporting] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [demoUrl, setDemoUrl] = useState(() => {
    try {
      return sessionStorage.getItem(DEMO_URL_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [copied, setCopied] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const stoppingRef = useRef(false);

  // Close the popover on outside click or Escape — mirrors ExportButton.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // Elapsed-time ticker while recording.
  useEffect(() => {
    if (!recording) return;
    const startedAt = Date.now();
    setElapsedMs(0);
    const id = window.setInterval(() => {
      setElapsedMs(Date.now() - startedAt);
    }, 1000);
    return () => window.clearInterval(id);
  }, [recording]);

  const doStop = async () => {
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    setImporting(true);
    try {
      const { file, telemetry } = await recorder.stop();
      await importAndPersistVideoFile(file, telemetry);
    } catch (e) {
      console.error('Failed to finish recording', e);
    } finally {
      setImporting(false);
      setRecording(false);
      stoppingRef.current = false;
    }
  };

  // Wire up the browser's own stop-share UI to the same stop path.
  useEffect(() => {
    recorder.onautostop = () => {
      void doStop();
    };
    return () => {
      recorder.onautostop = null;
    };
  }, []);

  const handleDemoUrlChange = (value: string) => {
    setDemoUrl(value);
    try {
      sessionStorage.setItem(DEMO_URL_KEY, value);
    } catch {
      // sessionStorage unavailable — persistence is a nice-to-have only
    }
  };

  const openDemo = () => {
    if (!demoUrl.trim()) return;
    openDemoPage(demoUrl.trim());
  };

  const copyBookmarklet = async () => {
    try {
      await navigator.clipboard.writeText(buildBookmarklet());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      console.error('Failed to copy bookmarklet', e);
    }
  };

  const startRecording = async () => {
    try {
      await recorder.start();
      setOpen(false);
      setRecording(true);
    } catch {
      // User cancelled the share picker (or permission denied) — stay idle.
    }
  };

  const handleButtonClick = () => {
    if (importing) return;
    if (recording) {
      void doStop();
      return;
    }
    setOpen((v) => !v);
  };

  return (
    <div className="rp-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`btn rp-btn${recording ? ' rp-btn-live' : ''}`}
        onClick={handleButtonClick}
        disabled={importing}
      >
        {importing ? (
          'Importing…'
        ) : recording ? (
          <>
            <span className="rp-dot" aria-hidden="true" />
            {formatElapsed(elapsedMs)}
          </>
        ) : (
          'Record'
        )}
      </button>

      {open && !recording && (
        <div className="rp-popover" role="dialog" aria-label="Record a demo">
          <div className="rp-popover-header">
            <span>Record</span>
            <button
              type="button"
              className="rp-popover-close"
              aria-label="Close record panel"
              onClick={() => setOpen(false)}
            >
              &times;
            </button>
          </div>

          <div className="rp-popover-group">
            <span className="rp-popover-label">Demo page URL</span>
            <div className="rp-url-row">
              <input
                type="text"
                className="text-input rp-url-input"
                placeholder="https://example.com"
                value={demoUrl}
                onChange={(e) => handleDemoUrlChange(e.target.value)}
              />
              <button type="button" className="btn rp-open-btn" onClick={openDemo}>
                Open
              </button>
            </div>
          </div>

          <div className="rp-popover-group">
            <button type="button" className="btn rp-copy-btn" onClick={() => void copyBookmarklet()}>
              {copied ? 'Copied!' : 'Copy bookmarklet'}
            </button>
            <span className="hint rp-hint">
              Open the demo page with the Open button, then click the bookmarklet on that page — pointer
              telemetry (clicks for auto-zoom &amp; ripples) will be captured while recording. Coordinates are
              only accurate when recording that browser tab (not a window or screen).
            </span>
          </div>

          <div className="rp-popover-actions">
            <button type="button" className="btn rp-start-btn" onClick={() => void startRecording()}>
              Start recording
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
