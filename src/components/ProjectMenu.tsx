import { useEffect, useRef, useState } from 'react';
import {
  createProject,
  deleteProject,
  listProjects,
  renameProject,
  switchProject,
  type ProjectInfo,
} from '../state/persist';
import { useEditor } from '../state/store';
import './ProjectMenu.css';

/** Tiny "time ago" formatter — no dependencies. */
function timeAgo(ts: number): string {
  const diffSec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (diffSec < 5) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  const diffMonth = Math.round(diffDay / 30);
  if (diffMonth < 12) return `${diffMonth}mo ago`;
  const diffYear = Math.round(diffMonth / 12);
  return `${diffYear}y ago`;
}

const DELETE_ARM_MS = 4000;

export default function ProjectMenu() {
  const projectId = useEditor((s) => s.projectId);
  const projectName = useEditor((s) => s.projectName);

  const [open, setOpen] = useState(false);
  const [nameInput, setNameInput] = useState(projectName);
  const [projects, setProjects] = useState<ProjectInfo[] | null>(null);
  const [listError, setListError] = useState(false);
  const [armedDeleteId, setArmedDeleteId] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const disarmTimer = useRef<number | null>(null);

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

  // Refresh the project list and the rename field every time the popover opens.
  useEffect(() => {
    if (!open) return;
    setNameInput(projectName);
    setArmedDeleteId(null);
    setProjects(null);
    setListError(false);
    let cancelled = false;
    (async () => {
      try {
        const list = await listProjects();
        if (!cancelled) setProjects(list);
      } catch (e) {
        console.warn('listProjects failed:', e);
        if (!cancelled) setListError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Deliberately keyed only on `open` — a fresh fetch each time it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    return () => {
      if (disarmTimer.current !== null) window.clearTimeout(disarmTimer.current);
    };
  }, []);

  const refreshList = async () => {
    try {
      setProjects(await listProjects());
      setListError(false);
    } catch (e) {
      console.warn('listProjects failed:', e);
      setListError(true);
    }
  };

  const commitRename = () => {
    const trimmed = nameInput.trim();
    if (trimmed && trimmed !== projectName) void renameProject(trimmed);
    else setNameInput(projectName);
  };

  const armDelete = (id: string) => {
    if (disarmTimer.current !== null) window.clearTimeout(disarmTimer.current);
    setArmedDeleteId(id);
    disarmTimer.current = window.setTimeout(() => {
      disarmTimer.current = null;
      setArmedDeleteId(null);
    }, DELETE_ARM_MS);
  };

  const confirmDelete = async (id: string) => {
    if (disarmTimer.current !== null) window.clearTimeout(disarmTimer.current);
    setArmedDeleteId(null);
    await deleteProject(id);
    await refreshList();
  };

  const handleSwitch = async (id: string) => {
    await switchProject(id);
    setOpen(false);
  };

  const handleNew = async () => {
    await createProject('Untitled project');
    setOpen(false);
  };

  return (
    <div className="pm-wrap" ref={wrapRef}>
      <button
        type="button"
        className="btn pm-trigger"
        data-testid="project-menu-btn"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="pm-trigger-name">{projectName}</span>
        <span className="pm-trigger-caret">&#9662;</span>
      </button>

      {open && (
        <div className="pm-popover" role="dialog" aria-label="Project menu">
          <input
            type="text"
            className="pm-rename-input"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
            aria-label="Project name"
          />

          <div className="pm-list">
            {listError && <div className="pm-muted">Projects unavailable</div>}
            {!listError && projects === null && <div className="pm-muted">Loading&hellip;</div>}
            {!listError && projects !== null && projects.length === 0 && (
              <div className="pm-muted">No saved projects</div>
            )}
            {!listError &&
              projects !== null &&
              projects.map((p) => {
                const isActive = p.id === projectId;
                const armed = armedDeleteId === p.id;
                return (
                  <div key={p.id} className={`pm-row${isActive ? ' pm-row-active' : ''}`}>
                    <button
                      type="button"
                      className="pm-row-main"
                      disabled={isActive}
                      onClick={() => void handleSwitch(p.id)}
                    >
                      <span className="pm-row-name">{p.name}</span>
                      <span className="pm-row-time">{timeAgo(p.updatedAt)}</span>
                    </button>
                    <button
                      type="button"
                      className={`pm-row-delete${armed ? ' pm-row-delete-armed' : ''}`}
                      aria-label={`Delete ${p.name}`}
                      onClick={() => (armed ? void confirmDelete(p.id) : armDelete(p.id))}
                    >
                      {armed ? 'Delete?' : '✕'}
                    </button>
                  </div>
                );
              })}
          </div>

          <button type="button" className="pm-new-btn" onClick={() => void handleNew()}>
            New project
          </button>
        </div>
      )}
    </div>
  );
}
