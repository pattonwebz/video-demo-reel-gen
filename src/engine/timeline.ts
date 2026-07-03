import type { Project, SourceClip, TimelineClip } from './types';

/** Duration of a timeline clip in timeline-time ms (trim window / speed). */
export function clipDurationMs(clip: TimelineClip): number {
  return (clip.outMs - clip.inMs) / clip.speed;
}

export function timelineDurationMs(project: Project): number {
  return project.timeline.reduce((sum, c) => sum + clipDurationMs(c), 0);
}

export interface TimelineHit {
  clip: TimelineClip;
  source: SourceClip;
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
      const source = project.sources[clip.sourceId];
      if (!source) return null;
      return {
        clip,
        source,
        sourceTimeMs: clip.inMs + (timeMs - cursor) * clip.speed,
        clipStartMs: cursor,
      };
    }
    cursor += dur;
  }
  return null;
}
