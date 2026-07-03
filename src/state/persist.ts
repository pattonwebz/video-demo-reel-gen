import type { PointerSample, Project, SourceClip } from '../engine/types';
import { defaultProject } from '../engine/types';
import { backgroundImages } from '../engine/assets';
import { importVideoFile, mediaBlobs, newId, useEditor } from './store';

/**
 * Named multi-project persistence in OPFS:
 *
 *   index.json                     — { activeId, projects: [{id, name, updatedAt}] }
 *   projects/<projectId>.json      — one Project document each
 *   media/<blobId>                 — media blobs (source videos, music,
 *                                    background images), shared across
 *                                    projects since blob ids are unique
 *
 * Autosave is debounced off store subscription and writes the active
 * project + index. Restore runs once at startup before autosave attaches.
 * Deleting a project leaves its media orphaned in media/ — harmless, and a
 * "clear everything" wipe removes it all.
 */

export interface ProjectInfo {
  id: string;
  name: string;
  updatedAt: number;
}

interface ProjectIndex {
  activeId: string | null;
  projects: ProjectInfo[];
}

const INDEX_FILE = 'index.json';
const PROJECTS_DIR = 'projects';
const MEDIA_DIR = 'media';

async function dir(name: string, create: boolean): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(name, { create });
}

async function writeFile(parent: FileSystemDirectoryHandle, name: string, data: Blob | string): Promise<void> {
  const handle = await parent.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(data);
  await writable.close();
}

async function readText(parent: FileSystemDirectoryHandle, name: string): Promise<string> {
  return (await (await parent.getFileHandle(name)).getFile()).text();
}

async function readIndex(): Promise<ProjectIndex> {
  try {
    const root = await navigator.storage.getDirectory();
    const parsed = JSON.parse(await readText(root, INDEX_FILE)) as ProjectIndex;
    return { activeId: parsed.activeId ?? null, projects: parsed.projects ?? [] };
  } catch {
    return { activeId: null, projects: [] };
  }
}

async function writeIndex(index: ProjectIndex): Promise<void> {
  const root = await navigator.storage.getDirectory();
  await writeFile(root, INDEX_FILE, JSON.stringify(index));
}

/** Fire-and-forget copy of a media blob into OPFS. */
export async function persistMedia(id: string, blob: Blob): Promise<void> {
  try {
    await writeFile(await dir(MEDIA_DIR, true), id, blob);
  } catch (e) {
    console.warn('persistMedia failed:', e);
  }
}

/** Import a video file into the project AND into OPFS. UI entry points use this. */
export async function importAndPersistVideoFile(file: File, telemetry?: PointerSample[]): Promise<SourceClip> {
  const clip = await importVideoFile(file, telemetry);
  void persistMedia(clip.id, file);
  return clip;
}

export async function listProjects(): Promise<ProjectInfo[]> {
  return (await readIndex()).projects.sort((a, b) => b.updatedAt - a.updatedAt);
}

async function saveActiveProject(): Promise<void> {
  const { project, projectId, projectName } = useEditor.getState();
  try {
    // Blob URLs are session-transient; blank them so stale ones never load.
    const serializable: Project = {
      ...project,
      sources: Object.fromEntries(
        Object.entries(project.sources).map(([id, src]) => [id, { ...src, url: '' }]),
      ),
    };
    await writeFile(await dir(PROJECTS_DIR, true), `${projectId}.json`, JSON.stringify(serializable));
    const index = await readIndex();
    const info: ProjectInfo = { id: projectId, name: projectName, updatedAt: Date.now() };
    index.projects = [info, ...index.projects.filter((p) => p.id !== projectId)];
    index.activeId = projectId;
    await writeIndex(index);
  } catch (e) {
    console.warn('project autosave failed:', e);
  }
}

let saveTimer: number | null = null;

function scheduleSave(): void {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    void saveActiveProject();
  }, 1000);
}

/** Debounced autosave on project content or name changes. Call once, after restore. */
export function startAutosave(): void {
  useEditor.subscribe((state, prev) => {
    if (state.project !== prev.project || state.projectName !== prev.projectName) scheduleSave();
  });
}

/** Hydrate a stored project document's blobs and make it the open project. */
async function activateProject(info: ProjectInfo): Promise<boolean> {
  try {
    const project = JSON.parse(await readText(await dir(PROJECTS_DIR, false), `${info.id}.json`)) as Project;
    const media = await dir(MEDIA_DIR, true);

    const missingSources: string[] = [];
    for (const src of Object.values(project.sources)) {
      try {
        const file = await (await media.getFileHandle(src.id)).getFile();
        mediaBlobs.set(src.id, file);
        src.url = URL.createObjectURL(file);
      } catch {
        missingSources.push(src.id);
      }
    }
    for (const id of missingSources) {
      delete project.sources[id];
      project.timeline = project.timeline.filter((c) => c.sourceId !== id);
    }

    if (project.music) {
      try {
        mediaBlobs.set(
          project.music.blobId,
          await (await media.getFileHandle(project.music.blobId)).getFile(),
        );
      } catch {
        delete project.music;
      }
    }

    const bg = project.canvas.background;
    if (bg.type === 'image' && !backgroundImages.has(bg.imageId)) {
      try {
        const file = await (await media.getFileHandle(bg.imageId)).getFile();
        backgroundImages.set(bg.imageId, await createImageBitmap(file));
      } catch {
        project.canvas.background = defaultProject().canvas.background;
      }
    }

    // Forward compatibility: fill fields added after this project was saved.
    const defaults = defaultProject();
    project.canvas = { ...defaults.canvas, ...project.canvas };
    project.captions ??= [];
    project.zooms ??= [];

    const state = useEditor.getState();
    state.setProjectMeta({ id: info.id, name: info.name });
    state.replaceProject(project);
    const index = await readIndex();
    index.activeId = info.id;
    await writeIndex(index);
    return true;
  } catch (e) {
    console.warn(`could not load project ${info.id}:`, e);
    return false;
  }
}

/** Startup restore: reopen the last active project. False if there is none. */
export async function restoreLastProject(): Promise<boolean> {
  const index = await readIndex();
  const info = index.projects.find((p) => p.id === index.activeId) ?? index.projects[0];
  return info ? activateProject(info) : false;
}

/** Flush the current project, then open another by id. */
export async function switchProject(id: string): Promise<boolean> {
  const index = await readIndex();
  const info = index.projects.find((p) => p.id === id);
  if (!info) return false;
  await saveActiveProject();
  return activateProject(info);
}

/** Flush the current project, then start a fresh named one. */
export async function createProject(name: string): Promise<void> {
  await saveActiveProject();
  const state = useEditor.getState();
  state.setProjectMeta({ id: newId('proj'), name: name.trim() || 'Untitled project' });
  state.replaceProject(defaultProject());
  await saveActiveProject();
}

export async function renameProject(name: string): Promise<void> {
  useEditor.getState().setProjectMeta({ name: name.trim() || 'Untitled project' });
  await saveActiveProject();
}

/** Delete a stored project. Deleting the open one switches away or resets. */
export async function deleteProject(id: string): Promise<void> {
  const index = await readIndex();
  index.projects = index.projects.filter((p) => p.id !== id);
  if (index.activeId === id) index.activeId = index.projects[0]?.id ?? null;
  await writeIndex(index);
  try {
    await (await dir(PROJECTS_DIR, false)).removeEntry(`${id}.json`);
  } catch {
    // already gone
  }
  if (useEditor.getState().projectId === id) {
    const next = index.projects[0];
    if (next) await activateProject(next);
    else {
      const state = useEditor.getState();
      state.setProjectMeta({ id: newId('proj'), name: 'Untitled project' });
      state.replaceProject(defaultProject());
    }
  }
}
