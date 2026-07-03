/** M1 check: import a clip, confirm styled preview renders video + background. */
import { withApp, waitFor, canvasPixel, shot, assert } from './verify.mjs';

const TEST_VIDEO = process.argv[2];
if (!TEST_VIDEO) {
  console.error('usage: node scripts/verify-m1.mjs <video-file>');
  process.exit(1);
}

await withApp(async (page) => {
  await shot(page, 'm1-empty');

  await page.setInputFiles('input[type=file]', TEST_VIDEO);
  await waitFor(
    () => page.evaluate(() => document.querySelector('.preview-controls') !== null),
    10000,
    'clip imported',
  );
  // Let the video element produce frames.
  await page.click('.preview-controls .btn'); // play
  await page.waitForTimeout(1500);
  await shot(page, 'm1-imported');

  // Corner should be background (Dusk gradient start ≈ #3b2667 at top-left).
  const corner = await canvasPixel(page, 5, 5);
  assert(corner[3] === 255 && corner[2] > corner[1], `corner is gradient-ish (got ${corner})`);

  // Center should be video content — testsrc2 is colorful/bright; just require
  // it not to equal the corner background.
  const center = await canvasPixel(page, 960, 540);
  assert(
    Math.abs(center[0] - corner[0]) + Math.abs(center[1] - corner[1]) + Math.abs(center[2] - corner[2]) > 30,
    `center differs from background (bg=${corner} center=${center})`,
  );

  // Playback advances.
  const t1 = await page.evaluate(() => document.querySelector('video').currentTime);
  await page.waitForTimeout(700);
  const t2 = await page.evaluate(() => document.querySelector('video').currentTime);
  assert(t2 > t1, `video is playing (${t1.toFixed(2)} → ${t2.toFixed(2)})`);

  // Aspect presets switch canvas dimensions.
  await page.click('.chip:has-text("Vertical")');
  await page.waitForTimeout(300);
  const dims = await page.evaluate(() => {
    const c = document.querySelector('[data-testid="preview-canvas"]');
    return [c.width, c.height];
  });
  assert(dims[0] === 1080 && dims[1] === 1920, `vertical preset applied (got ${dims})`);
  await shot(page, 'm1-vertical');
});
console.log('M1 verification done.');
