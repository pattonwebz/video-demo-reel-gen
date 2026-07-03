import { create } from 'zustand';
import type {
  Background,
  ClipTransition,
  FrameChrome,
  Project,
  SourceClip,
  TimelineClip,
  TitleCard,
  ZoomSegment,
} from '../engine/types';
import { defaultProject } from '../engine/types';
import { clipAt } from '../engine/timeline';

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
  /** Timeline clip currently under edit (clip track highlight + inspector). */
  selectedClipId: string | null;
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
  setChrome: (chrome: FrameChrome) => void;
  setZoomVignette: (v: number) => void;
  addSource: (clip: SourceClip) => void;
  setCurrentTime: (ms: number) => void;
  setPlaying: (playing: boolean) => void;

  /** Adds the segment, selects it, and returns its new id. */
  addZoom: (seg: Omit<ZoomSegment, 'id'>) => string;
  updateZoom: (id: string, patch: Partial<Omit<ZoomSegment, 'id'>>) => void;
  removeZoom: (id: string) => void;
  setSelectedZoom: (id: string | null) => void;
  setSelectedClip: (id: string | null) => void;

  /** Move the clip at fromIndex to toIndex (both in timeline order). */
  reorderClip: (fromIndex: number, toIndex: number) => void;
  /** Patch a clip's trim window / speed, clamped to the source and sane minimums. */
  updateClip: (id: string, patch: Partial<Pick<TimelineClip, 'inMs' | 'outMs' | 'speed'>>) => void;
  /** Split the clip under the given timeline time into two at that point. */
  splitClipAt: (timelineMs: number) => void;
  removeClip: (id: string) => void;
  /** Appends a 3s title-card clip, selects it, and returns its id. */
  addTitleCard: () => string;
  updateCard: (id: string, patch: Partial<TitleCard>) => void;
  /** Set or clear the dip transition on the boundary after a clip. */
  setClipTransition: (id: string, transition: ClipTransition | null) => void;

  requestSeek: (ms: number) => void;
  clearSeekRequest: () => void;
}

/** Minimum clip length in source ms — keeps trims/splits from degenerating. */
const MIN_CLIP_SOURCE_MS = 100;

export const useEditor = create<EditorState>((set) => ({
  project: defaultProject(),
  currentTimeMs: 0,
  playing: false,
  selectedZoomId: null,
  selectedClipId: null,
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
  setChrome: (chrome) =>
    set((s) => ({ project: { ...s.project, canvas: { ...s.project.canvas, chrome } } })),
  setZoomVignette: (zoomVignette) =>
    set((s) => ({ project: { ...s.project, canvas: { ...s.project.canvas, zoomVignette } } })),
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
  setSelectedClip: (selectedClipId) => set({ selectedClipId }),

  reorderClip: (fromIndex, toIndex) =>
    set((s) => {
      const timeline = [...s.project.timeline];
      if (fromIndex < 0 || fromIndex >= timeline.length) return {};
      const to = Math.max(0, Math.min(timeline.length - 1, toIndex));
      const [clip] = timeline.splice(fromIndex, 1);
      timeline.splice(to, 0, clip);
      return { project: { ...s.project, timeline } };
    }),
  updateClip: (id, patch) =>
    set((s) => ({
      project: {
        ...s.project,
        timeline: s.project.timeline.map((c) => {
          if (c.id !== id) return c;
          const source = c.sourceId !== null ? s.project.sources[c.sourceId] : null;
          const maxOut = source ? source.durationMs : c.outMs;
          const next = { ...c, ...patch };
          next.speed = Math.min(4, Math.max(0.25, next.speed));
          next.inMs = Math.min(Math.max(0, next.inMs), maxOut - MIN_CLIP_SOURCE_MS);
          next.outMs = Math.min(Math.max(next.outMs, next.inMs + MIN_CLIP_SOURCE_MS), maxOut);
          return next;
        }),
      },
    })),
  splitClipAt: (timelineMs) =>
    set((s) => {
      const hit = clipAt(s.project, timelineMs);
      if (!hit || hit.clip.sourceId === null) return {}; // title cards don't split
      const { clip, sourceTimeMs } = hit;
      // Refuse splits that would leave a sliver on either side.
      if (sourceTimeMs < clip.inMs + MIN_CLIP_SOURCE_MS || sourceTimeMs > clip.outMs - MIN_CLIP_SOURCE_MS) return {};
      const left: TimelineClip = { ...clip, id: newId('tl'), outMs: sourceTimeMs };
      const right: TimelineClip = { ...clip, id: newId('tl'), inMs: sourceTimeMs };
      return {
        project: {
          ...s.project,
          timeline: s.project.timeline.flatMap((c) => (c.id === clip.id ? [left, right] : [c])),
        },
        selectedClipId: left.id,
      };
    }),
  removeClip: (id) =>
    set((s) => ({
      project: { ...s.project, timeline: s.project.timeline.filter((c) => c.id !== id) },
      selectedClipId: s.selectedClipId === id ? null : s.selectedClipId,
    })),
  addTitleCard: () => {
    const id = newId('tl');
    set((s) => ({
      project: {
        ...s.project,
        timeline: [
          ...s.project.timeline,
          {
            id,
            sourceId: null,
            inMs: 0,
            outMs: 3000,
            speed: 1,
            card: { heading: 'Title', durationMs: 3000 },
          },
        ],
      },
      selectedClipId: id,
      selectedZoomId: null,
    }));
    return id;
  },
  updateCard: (id, patch) =>
    set((s) => ({
      project: {
        ...s.project,
        timeline: s.project.timeline.map((c) => {
          if (c.id !== id || !c.card) return c;
          const card = { ...c.card, ...patch };
          card.durationMs = Math.max(500, card.durationMs);
          return { ...c, card, inMs: 0, outMs: card.durationMs };
        }),
      },
    })),
  setClipTransition: (id, transition) =>
    set((s) => ({
      project: {
        ...s.project,
        timeline: s.project.timeline.map((c) =>
          c.id === id ? { ...c, transitionOut: transition ?? undefined } : c,
        ),
      },
    })),

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
