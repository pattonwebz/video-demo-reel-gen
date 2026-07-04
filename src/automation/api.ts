import type {
  CanvasSettings,
  CaptionSegment,
  MusicTrack,
  PointerSample,
  Project,
  TitleCard,
} from '../engine/types';
import { exportProject, type ExportOptions } from '../engine/export';
import { useEditor, mediaBlobs, newId } from '../state/store';
import { importAndPersistVideoFile, persistMedia } from '../state/persist';

/**
 * Headless-driver API for the scripted record→render pipeline (see
 * docs-local/AUTOMATION-PLAN.md). Installed on window.__demoReel ONLY when
 * the page is opened with ?automation=1 — never on the normal user path.
 *
 * Deliberately a dumb façade over existing store/persist functions: no
 * logic lives here, so the store stays the single source of truth and this
 * surface can't drift from what the UI does.
 */
export interface DemoReelAutomationApi {
  ready: true;
  /** Import a recording with synthesized telemetry; resolves to the new sourceId. */
  importRecording(blob: Blob, telemetry: PointerSample[], name?: string): Promise<string>;
  /** Replace the whole open project document. */
  loadProject(json: Project): void;
  /** Snapshot of the open project, for the driver to inspect/assert. */
  getProject(): Project;
  /** Timeline clip ids in order — importRecording appends, so the last id is the new clip. */
  getTimelineClipIds(): string[];
  /** Generate zooms from a clip's click telemetry; returns how many were added. */
  autoZoomClip(clipId: string): number;
  addCaption(seg: Omit<CaptionSegment, 'id'>): string;
  addTitleCard(patch?: Partial<TitleCard>): string;
  /** Register + persist a music blob and set it on the project. */
  setMusic(blob: Blob, opts?: { name?: string } & Partial<Omit<MusicTrack, 'blobId' | 'name'>>): Promise<void>;
  applyCanvas(patch: Partial<CanvasSettings>): void;
  /**
   * Render and trigger the MP4 download (the driver catches it via
   * Playwright's download event). Resolves when encoding finishes.
   */
  exportMp4(opts?: Omit<ExportOptions, 'onProgress'>): Promise<void>;
}

declare global {
  interface Window {
    __demoReel?: DemoReelAutomationApi;
  }
}

export function installAutomationApi(): void {
  window.__demoReel = {
    ready: true,

    async importRecording(blob, telemetry, name = 'recording.webm') {
      const file = new File([blob], name, { type: blob.type || 'video/webm' });
      const clip = await importAndPersistVideoFile(file, telemetry);
      return clip.id;
    },

    loadProject(json) {
      useEditor.getState().replaceProject(json);
    },

    getProject() {
      return useEditor.getState().project;
    },

    getTimelineClipIds() {
      return useEditor.getState().project.timeline.map((c) => c.id);
    },

    autoZoomClip(clipId) {
      return useEditor.getState().autoZoomClip(clipId);
    },

    addCaption(seg) {
      return useEditor.getState().addCaption(seg);
    },

    addTitleCard(patch) {
      const state = useEditor.getState();
      const id = state.addTitleCard();
      if (patch) state.updateCard(id, patch);
      return id;
    },

    async setMusic(blob, opts = {}) {
      const { name = 'music', gain = 0.6, fadeInMs = 500, fadeOutMs = 1000 } = opts;
      const blobId = newId('music');
      mediaBlobs.set(blobId, blob);
      await persistMedia(blobId, blob);
      useEditor.getState().setMusic({ blobId, name, gain, fadeInMs, fadeOutMs });
    },

    applyCanvas(patch) {
      const s = useEditor.getState();
      s.replaceProject({
        ...s.project,
        canvas: { ...s.project.canvas, ...patch },
      });
    },

    async exportMp4(opts = {}) {
      const { project } = useEditor.getState();
      const blob = await exportProject(project, mediaBlobs, opts);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'demo-reel.mp4';
      a.click();
    },
  };
}
