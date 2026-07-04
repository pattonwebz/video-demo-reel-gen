import type { PointerSample } from '../engine/types';
import { TelemetryReceiver } from './telemetry';

export interface RecordingResult {
  file: File;
  telemetry: PointerSample[];
}

const MIME_CANDIDATES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];

/**
 * Screen + mic recorder. Display capture (with tab/system audio when the
 * user grants it) and microphone are merged into one stream — audio via a
 * WebAudio mixdown, since MediaRecorder won't mix two audio tracks itself.
 * Pointer telemetry from the demoed page (see telemetry.ts) is collected for
 * the duration of the recording and returned alongside the file.
 */
export class DemoRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private streams: MediaStream[] = [];
  private audioCtx: AudioContext | null = null;
  private telemetry = new TelemetryReceiver();
  private flushed: Promise<void> | null = null;
  /** Fired when the browser's own stop-share UI ends the capture; call stop() to collect. */
  onautostop: (() => void) | null = null;

  get recording(): boolean {
    return this.recorder !== null && this.recorder.state === 'recording';
  }

  async start(): Promise<void> {
    if (this.recorder) throw new Error('Already recording');
    const display = await navigator.mediaDevices.getDisplayMedia({
      // `cursor: 'never'` lets the synthetic smoothed cursor replace the real
      // one; browsers that don't support the constraint just ignore it.
      video: { frameRate: 30, cursor: 'never' } as MediaTrackConstraints,
      audio: true,
    });
    this.streams.push(display);
    let mic: MediaStream | null = null;
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.streams.push(mic);
    } catch {
      mic = null; // no mic permission — screen-only audio
    }

    const tracks: MediaStreamTrack[] = [...display.getVideoTracks()];
    const audioStreams = [display, mic].filter((s): s is MediaStream => !!s && s.getAudioTracks().length > 0);
    if (audioStreams.length === 1) {
      tracks.push(audioStreams[0].getAudioTracks()[0]);
    } else if (audioStreams.length > 1) {
      this.audioCtx = new AudioContext();
      const dest = this.audioCtx.createMediaStreamDestination();
      for (const s of audioStreams) this.audioCtx.createMediaStreamSource(s).connect(dest);
      tracks.push(...dest.stream.getAudioTracks());
    }

    const mime = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
    this.chunks = [];
    this.recorder = new MediaRecorder(new MediaStream(tracks), mime ? { mimeType: mime } : undefined);
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    // Attach onstop before start so a browser-initiated stop (stop-share UI)
    // still resolves a later stop() call instead of hanging it.
    const recorder = this.recorder;
    this.flushed = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    this.telemetry.begin(Date.now());
    this.recorder.start(1000);

    // Ending the share via the browser's own UI should finish the recording.
    display.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (this.recording) {
        this.recorder?.stop();
        this.onautostop?.();
      }
    });
  }

  /** Resolves with the recorded file once the recorder has flushed. */
  async stop(): Promise<RecordingResult> {
    const recorder = this.recorder;
    if (!recorder || !this.flushed) throw new Error('Not recording');
    if (recorder.state !== 'inactive') recorder.stop();
    await this.flushed;
    this.flushed = null;

    const telemetry = this.telemetry.end();
    for (const s of this.streams) s.getTracks().forEach((t) => t.stop());
    this.streams = [];
    void this.audioCtx?.close();
    this.audioCtx = null;
    this.recorder = null;

    const type = recorder.mimeType || 'video/webm';
    const file = new File(this.chunks, `recording-${new Date().toISOString().slice(0, 19)}.webm`, { type });
    this.chunks = [];
    return { file, telemetry };
  }
}
