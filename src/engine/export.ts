import {
  ALL_FORMATS,
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
import type { Project } from './types';
import { renderFrame } from './compositor';
import { clipAt, timelineDurationMs } from './timeline';

export interface ExportOptions {
  fps?: number;
  /** Output bitrate in bits/s. */
  videoBitrate?: number;
  onProgress?: (fraction: number) => void;
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
  const videoBitrate = opts.videoBitrate ?? 8_000_000;
  const durationMs = timelineDurationMs(project);
  if (durationMs <= 0) throw new Error('Timeline is empty');

  // Open one Input + frame sink per distinct source used on the timeline.
  const inputs = new Map<string, { input: Input; sink: VideoSampleSink | null }>();
  for (const clip of project.timeline) {
    if (inputs.has(clip.sourceId)) continue;
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

  const audio = await prepareAudioPassthrough(project, inputs, output);

  await output.start();

  const totalFrames = Math.ceil((durationMs / 1000) * fps);
  for (let i = 0; i < totalFrames; i++) {
    const tMs = (i / fps) * 1000;
    const hit = clipAt(project, tMs);
    let frame = null;
    if (hit) {
      const sink = inputs.get(hit.clip.sourceId)?.sink;
      const sample = await sink?.getSample(hit.sourceTimeMs / 1000);
      if (sample) {
        frame = {
          image: sample.toCanvasImageSource(),
          width: sample.displayWidth,
          height: sample.displayHeight,
          close: () => sample.close(),
        };
      }
    }
    renderFrame(ctx, project, tMs, frame);
    frame?.close();
    await videoSource.add(tMs / 1000, 1 / fps);
    opts.onProgress?.((i + 1) / totalFrames);
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
  if (clip.speed !== 1 || clip.inMs > 1) return null;

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
      let first = true;
      for await (const packet of packetSink.packets()) {
        if (packet.timestamp > endS) break;
        await source.add(packet, first ? { decoderConfig } : undefined);
        first = false;
      }
      source.close();
    },
  };
}
