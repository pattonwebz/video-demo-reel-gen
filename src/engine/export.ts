import {
  ALL_FORMATS,
  AudioBufferSource,
  BlobSource,
  BufferTarget,
  CanvasSource,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  Input,
  Mp4OutputFormat,
  Output,
  VideoSampleSink,
} from 'mediabunny';
import type { VideoSample } from 'mediabunny';
import type { Project } from './types';
import { renderFrame, renderFrameMotionBlur } from './compositor';
import { clipAt, clipDurationMs, timelineDurationMs } from './timeline';

export interface ExportOptions {
  fps?: number;
  /** Output bitrate in bits/s. */
  videoBitrate?: number;
  /** Canvas multiplier: 1 = project size (1080p default), 2 = 4K. */
  scale?: number;
  /** Average sub-samples across fast camera ramps (export-only; preview never blurs). */
  motionBlur?: boolean;
  onProgress?: (fraction: number) => void;
}

const MIX_SAMPLE_RATE = 48000;
const AUDIO_BITRATE = 128_000;

/** Scale the canvas (and its pixel-denominated settings) for hi-res export. */
function scaleProject(project: Project, scale: number): Project {
  if (scale === 1) return project;
  const c = project.canvas;
  return {
    ...project,
    canvas: {
      ...c,
      width: Math.round(c.width * scale),
      height: Math.round(c.height * scale),
      cornerRadius: c.cornerRadius * scale,
      shadow: { ...c.shadow, blur: c.shadow.blur * scale, offsetY: c.shadow.offsetY * scale },
    },
  };
}

/**
 * Render the project to an MP4 blob: decode source frames with Mediabunny,
 * run them through the same compositor as the preview on an OffscreenCanvas,
 * encode H.264, and (when the source audio codec is MP4-compatible and the
 * clip is untrimmed at speed 1) pass audio packets through without re-encoding.
 *
 * Current scope (export spike → grows in M4): renders the full timeline via
 * clipAt(); audio passthrough only for the single-clip untrimmed case.
 */
export async function exportProject(
  project: Project,
  blobs: Map<string, Blob>,
  opts: ExportOptions = {},
): Promise<Blob> {
  const fps = opts.fps ?? 30;
  const scale = opts.scale ?? 1;
  const videoBitrate = opts.videoBitrate ?? (scale > 1 ? 24_000_000 : 8_000_000);
  const durationMs = timelineDurationMs(project);
  if (durationMs <= 0) throw new Error('Timeline is empty');
  project = scaleProject(project, scale);

  // Open one Input + frame sink per distinct source used on the timeline.
  const inputs = new Map<string, { input: Input; sink: VideoSampleSink | null }>();
  for (const clip of project.timeline) {
    if (clip.sourceId === null || inputs.has(clip.sourceId)) continue; // title cards have no media
    const blob = blobs.get(clip.sourceId);
    if (!blob) throw new Error(`No media blob for source ${clip.sourceId}`);
    const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
    const videoTrack = await input.getPrimaryVideoTrack();
    inputs.set(clip.sourceId, {
      input,
      sink: videoTrack ? new VideoSampleSink(videoTrack) : null,
    });
  }

  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  const canvas = new OffscreenCanvas(project.canvas.width, project.canvas.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create OffscreenCanvas 2d context');

  const videoSource = new CanvasSource(canvas, { codec: 'avc', bitrate: videoBitrate });
  output.addVideoTrack(videoSource, { frameRate: fps });

  const audio =
    (await prepareAudioPassthrough(project, inputs, output)) ??
    (await prepareAudioMix(project, blobs, output));

  await output.start();

  const totalFrames = Math.ceil((durationMs / 1000) * fps);
  const emit = async (i: number, sample: VideoSample | null) => {
    const tMs = (i / fps) * 1000;
    const frame = sample
      ? { image: sample.toCanvasImageSource(), width: sample.displayWidth, height: sample.displayHeight }
      : null;
    if (opts.motionBlur) renderFrameMotionBlur(ctx, project, tMs, frame, fps);
    else renderFrame(ctx, project, tMs, frame);
    sample?.close();
    await videoSource.add(tMs / 1000, 1 / fps);
    opts.onProgress?.((i + 1) / totalFrames);
  };

  // Walk output frames grouped into contiguous runs on the same timeline clip,
  // so each run can decode sequentially via samplesAtTimestamps (decodes each
  // packet once) instead of getSample per frame (re-decodes from the previous
  // keyframe every call — unusably slow on long-GOP screen recordings).
  let i = 0;
  while (i < totalFrames) {
    const hit = clipAt(project, (i / fps) * 1000);
    const sink = hit?.clip.sourceId != null ? (inputs.get(hit.clip.sourceId)?.sink ?? null) : null;
    const sourceTimes: number[] = [];
    let end = i;
    while (end < totalFrames) {
      const h = clipAt(project, (end / fps) * 1000);
      if (h?.clip !== hit?.clip) break;
      sourceTimes.push(h ? h.sourceTimeMs / 1000 : 0);
      end++;
    }
    if (sink) {
      for await (const sample of sink.samplesAtTimestamps(sourceTimes)) {
        await emit(i++, sample);
      }
    }
    // Gap frames (or a sourceless run) render as background only.
    while (i < end) await emit(i++, null);
  }
  videoSource.close();

  if (audio) await audio.pump(durationMs / 1000);

  await output.finalize();
  const buffer = (output.target as BufferTarget).buffer;
  if (!buffer) throw new Error('Export produced no data');
  return new Blob([buffer], { type: 'video/mp4' });
}

/**
 * Set up audio passthrough for the simple case: exactly one timeline clip,
 * untrimmed, speed 1, with an MP4-compatible audio codec. Returns null (video
 * only) otherwise — M4 adds the decode/re-encode path.
 */
async function prepareAudioPassthrough(
  project: Project,
  inputs: Map<string, { input: Input; sink: VideoSampleSink | null }>,
  output: Output,
): Promise<{ pump: (endS: number) => Promise<void> } | null> {
  if (project.timeline.length !== 1) return null;
  const clip = project.timeline[0];
  if (clip.sourceId === null || clip.speed !== 1 || clip.inMs > 1) return null;

  const entry = inputs.get(clip.sourceId);
  if (!entry) return null;
  const audioTrack = await entry.input.getPrimaryAudioTrack();
  if (!audioTrack) return null;
  const codec = await audioTrack.getCodec();
  if (!codec) return null;
  const supported = output.format.getSupportedCodecs();
  if (!(supported as string[]).includes(codec)) return null;
  const decoderConfig = await audioTrack.getDecoderConfig();
  if (!decoderConfig) return null;

  const source = new EncodedAudioPacketSource(codec);
  output.addAudioTrack(source);
  const packetSink = new EncodedPacketSink(audioTrack);

  return {
    pump: async (endS: number) => {
      // AAC streams often start slightly negative (encoder priming); the MP4
      // muxer rejects negative timestamps, so shift the whole stream to 0.
      let shiftS: number | null = null;
      let first = true;
      for await (const packet of packetSink.packets()) {
        shiftS ??= Math.max(0, -packet.timestamp);
        const ts = packet.timestamp + shiftS;
        if (ts > endS) break;
        await source.add(
          shiftS > 0 ? packet.clone({ timestamp: ts }) : packet,
          first ? { decoderConfig } : undefined,
        );
        first = false;
      }
      source.close();
    },
  };
}

/**
 * General audio path for anything passthrough can't handle: decode each
 * contributing source in full (decodeAudioData), schedule the clips' trim
 * windows into an OfflineAudioContext at their timeline positions (which
 * also resamples and mixes down to 48kHz stereo), and re-encode as AAC.
 * Speed ≠ 1 clips and title cards contribute silence — pitch-preserving
 * time-stretch is out of scope, and chipmunk audio is worse than none.
 */
async function prepareAudioMix(
  project: Project,
  blobs: Map<string, Blob>,
  output: Output,
): Promise<{ pump: (endS: number) => Promise<void> } | null> {
  const contributors = project.timeline.filter((c) => c.sourceId !== null && c.speed === 1);
  if (contributors.length === 0) return null;

  const decoded = new Map<string, AudioBuffer>();
  for (const clip of contributors) {
    const sourceId = clip.sourceId as string;
    if (decoded.has(sourceId)) continue;
    const blob = blobs.get(sourceId);
    if (!blob) continue;
    try {
      const decodeCtx = new OfflineAudioContext(2, 1, MIX_SAMPLE_RATE);
      decoded.set(sourceId, await decodeCtx.decodeAudioData(await blob.arrayBuffer()));
    } catch {
      // Source has no audio track (or an undecodable one) — contributes silence.
    }
  }
  if (decoded.size === 0) return null;

  const totalS = timelineDurationMs(project) / 1000;
  const mixCtx = new OfflineAudioContext(2, Math.ceil(totalS * MIX_SAMPLE_RATE), MIX_SAMPLE_RATE);
  let cursorS = 0;
  for (const clip of project.timeline) {
    const durS = clipDurationMs(clip) / 1000;
    const buffer = clip.sourceId !== null && clip.speed === 1 ? decoded.get(clip.sourceId) : undefined;
    if (buffer) {
      const node = mixCtx.createBufferSource();
      node.buffer = buffer;
      node.connect(mixCtx.destination);
      node.start(cursorS, clip.inMs / 1000, durS);
    }
    cursorS += durS;
  }
  const rendered = await mixCtx.startRendering();

  const source = new AudioBufferSource({ codec: 'aac', bitrate: AUDIO_BITRATE });
  output.addAudioTrack(source);
  return {
    pump: async () => {
      await source.add(rendered);
      source.close();
    },
  };
}
