import { create } from 'zustand';
import type { Background, Project, SourceClip, ZoomSegment } from '../engine/types';
import { defaultProject } from '../engine/types';

let idCounter = 0;
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${(idCounter++).toString(36)}`;
}

interface EditorState {
  project: Project;
  /** Transient playback position on the timeline (not persisted). */
  currentTimeMs: number;
  playing: boolean;
  /** Zoom segment currently under edit (track highlight + inspector). */
  selectedZoomId: string | null;
  /**
   * One-shot seek request. The Preview owns the <video> element, so scrub/seek
   * consumers write here and Preview applies it to the element and clears it.
   */
  seekRequest: { ms: number } | null;

  setCanvasSize: (width: number, height: number) => void;
  setBackground: (bg: Background) => void;
  setPadding: (padding: number) => void;
  setCornerRadius: (r: number) => void;
  setShadowOpacity: (opacity: number) => void;
  setDefaultDriftPct: (pct: number) => void;
  addSource: (clip: SourceClip) => void;
  setCurrentTime: (ms: number) => void;
  setPlaying: (playing: boolean) => void;

  /** Adds the segment, selects it, and returns its new id. */
  addZoom: (seg: Omit<ZoomSegment, 'id'>) => string;
  updateZoom: (id: string, patch: Partial<Omit<ZoomSegment, 'id'>>) => void;
  removeZoom: (id: string) => void;
  setSelectedZoom: (id: string | null) => void;
  requestSeek: (ms: number) => void;
  clearSeekRequest: () => void;
}

export const useEditor = create<EditorState>((set) => ({
  project: defaultProject(),
  currentTimeMs: 0,
  playing: false,
  selectedZoomId: null,
  seekRequest: null,

  setCanvasSize: (width, height) =>
    set((s) => ({ project: { ...s.project, canvas: { ...s.project.canvas, width, height } } })),
  setBackground: (background) =>
    set((s) => ({ project: { ...s.project, canvas: { ...s.project.canvas, background } } })),
  setPadding: (padding) =>
    set((s) => ({ project: { ...s.project, canvas: { ...s.project.canvas, padding } } })),
  setCornerRadius: (cornerRadius) =>
    set((s) => ({ project: { ...s.project, canvas: { ...s.project.canvas, cornerRadius } } })),
  setShadowOpacity: (opacity) =>
    set((s) => ({
      project: {
        ...s.project,
        canvas: { ...s.project.canvas, shadow: { ...s.project.canvas.shadow, opacity } },
      },
    })),
  setDefaultDriftPct: (defaultDriftPct) =>
    set((s) => ({ project: { ...s.project, canvas: { ...s.project.canvas, defaultDriftPct } } })),
  addSource: (clip) =>
    set((s) => ({
      project: {
        ...s.project,
        sources: { ...s.project.sources, [clip.id]: clip },
        timeline: [
          ...s.project.timeline,
          { id: newId('tl'), sourceId: clip.id, inMs: 0, outMs: clip.durationMs, speed: 1 },
        ],
      },
    })),
  setCurrentTime: (currentTimeMs) => set({ currentTimeMs }),
  setPlaying: (playing) => set({ playing }),

  addZoom: (seg) => {
    const id = newId('zoom');
    set((s) => ({
      project: {
        ...s.project,
        zooms: [
          ...s.project.zooms,
          { driftPct: s.project.canvas.defaultDriftPct, ...seg, id },
        ],
      },
      selectedZoomId: id,
    }));
    return id;
  },
  updateZoom: (id, patch) =>
    set((s) => ({
      project: {
        ...s.project,
        zooms: s.project.zooms.map((z) => (z.id === id ? { ...z, ...patch } : z)),
      },
    })),
  removeZoom: (id) =>
    set((s) => ({
      project: { ...s.project, zooms: s.project.zooms.filter((z) => z.id !== id) },
      selectedZoomId: s.selectedZoomId === id ? null : s.selectedZoomId,
    })),
  setSelectedZoom: (selectedZoomId) => set({ selectedZoomId }),
  requestSeek: (ms) => set({ seekRequest: { ms } }),
  clearSeekRequest: () => set({ seekRequest: null }),
}));

/**
 * Media bytes by source id. Kept outside the store because blobs aren't
 * serializable project state (M6 moves persistence to OPFS).
 */
export const mediaBlobs = new Map<string, Blob>();

/** Probe a media file for duration/dimensions and register it as a source clip. */
export async function importVideoFile(file: File): Promise<SourceClip> {
  const url = URL.createObjectURL(file);
  const meta = await probeVideo(url);
  const clip: SourceClip = {
    id: newId('src'),
    name: file.name,
    url,
    durationMs: meta.durationMs,
    width: meta.width,
    height: meta.height,
  };
  mediaBlobs.set(clip.id, file);
  useEditor.getState().addSource(clip);
  return clip;
}

function probeVideo(url: string): Promise<{ durationMs: number; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      // WebM from MediaRecorder often reports Infinity until seeked to the end.
      if (!Number.isFinite(video.duration)) {
        video.currentTime = Number.MAX_SAFE_INTEGER;
        video.ontimeupdate = () => {
          video.ontimeupdate = null;
          resolve({
            durationMs: video.duration * 1000,
            width: video.videoWidth,
            height: video.videoHeight,
          });
          video.src = '';
        };
        return;
      }
      resolve({
        durationMs: video.duration * 1000,
        width: video.videoWidth,
        height: video.videoHeight,
      });
      video.src = '';
    };
    video.onerror = () => reject(new Error(`Could not read video metadata for ${url}`));
    video.src = url;
  });
}
