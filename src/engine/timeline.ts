import type { Project, SourceClip, TimelineClip, TransitionType } from './types';

/** Duration of a timeline clip in timeline-time ms (trim window / speed). */
export function clipDurationMs(clip: TimelineClip): number {
  if (clip.sourceId === null) return (clip.card?.durationMs ?? 0) / clip.speed;
  return (clip.outMs - clip.inMs) / clip.speed;
}

export function timelineDurationMs(project: Project): number {
  return project.timeline.reduce((sum, c) => sum + clipDurationMs(c), 0);
}

export interface TimelineHit {
  clip: TimelineClip;
  /** null for title-card clips, which have no source media. */
  source: SourceClip | null;
  /** Time within the source media, in source ms. */
  sourceTimeMs: number;
  /** Timeline time at which this clip starts. */
  clipStartMs: number;
}

/** Map a timeline time to the clip + source time under the playhead. */
export function clipAt(project: Project, timeMs: number): TimelineHit | null {
  let cursor = 0;
  for (const clip of project.timeline) {
    const dur = clipDurationMs(clip);
    if (timeMs < cursor + dur || clip === project.timeline[project.timeline.length - 1]) {
      if (timeMs >= cursor + dur) return null; // past the end of the last clip
      const source = clip.sourceId !== null ? project.sources[clip.sourceId] : null;
      if (clip.sourceId !== null && !source) return null;
      return {
        clip,
        source: source ?? null,
        sourceTimeMs: clip.inMs + (timeMs - cursor) * clip.speed,
        clipStartMs: cursor,
      };
    }
    cursor += dur;
  }
  return null;
}

export interface TransitionHit {
  type: TransitionType;
  /** Signed progress across the boundary: −1 entering, 0 at the cut, +1 clear of it. */
  p: number;
}

/**
 * Resolve the dip transition covering a timeline time, if any. A clip's
 * transitionOut spans the boundary after it, half on each side, with each
 * half clamped to half of the adjoining clip so short clips never vanish
 * entirely.
 */
export function transitionAt(project: Project, timeMs: number): TransitionHit | null {
  let cursor = 0;
  for (let i = 0; i < project.timeline.length - 1; i++) {
    const clip = project.timeline[i];
    const dur = clipDurationMs(clip);
    const cut = cursor + dur;
    const t = clip.transitionOut;
    if (t) {
      const nextDur = clipDurationMs(project.timeline[i + 1]);
      const half = Math.min(t.durationMs / 2, dur / 2, nextDur / 2);
      if (half > 0 && Math.abs(timeMs - cut) <= half) {
        return { type: t.type, p: (timeMs - cut) / half };
      }
    }
    cursor = cut;
  }
  return null;
}
