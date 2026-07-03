/**
 * Export spike check: import a clip, click Export MP4, capture the download,
 * and validate the file with ffprobe (container, codecs, duration, dims).
 */
import { execFileSync } from 'node:child_process';
import { withApp, waitFor, shot, assert } from './verify.mjs';

const TEST_VIDEO = process.argv[2];
if (!TEST_VIDEO) {
  console.error('usage: node scripts/verify-export.mjs <video-file>');
  process.exit(1);
}

await withApp(async (page) => {
  await page.setInputFiles('input[type=file]', TEST_VIDEO);
  await waitFor(
    () => page.evaluate(() => document.querySelector('.preview-controls') !== null),
    10000,
    'clip imported',
  );

  const downloadPromise = page.waitForEvent('download', { timeout: 120000 });
  await page.click('[data-testid="export-btn"]');
  await shot(page, 'export-in-progress');
  const download = await downloadPromise;
  const outPath = 'test-output/exported.mp4';
  await download.saveAs(outPath);
  await shot(page, 'export-done');

  const probe = JSON.parse(
    execFileSync('ffprobe', [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format', '-show_streams',
      outPath,
    ]).toString(),
  );
  const video = probe.streams.find((s) => s.codec_type === 'video');
  const audio = probe.streams.find((s) => s.codec_type === 'audio');
  assert(probe.format.format_name.includes('mp4'), `container is mp4 (${probe.format.format_name})`);
  assert(video?.codec_name === 'h264', `video codec h264 (${video?.codec_name})`);
  assert(video?.width === 1920 && video?.height === 1080, `1080p output (${video?.width}x${video?.height})`);
  const dur = Number(probe.format.duration);
  assert(Math.abs(dur - 5) < 0.5, `duration ≈5s (${dur})`);
  assert(audio != null, `has audio track (${audio?.codec_name ?? 'none'})`);
  console.log(`ffprobe summary: v=${video?.codec_name} ${video?.width}x${video?.height}, a=${audio?.codec_name}, dur=${dur}s`);
});
console.log('Export verification done.');
