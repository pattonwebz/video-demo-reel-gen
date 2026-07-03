/**
 * Headless verification harness: starts the vite dev server, drives the app
 * in headless Chrome (system /usr/bin/google-chrome via playwright-core),
 * and runs the named check. Screenshots land in test-output/.
 *
 * Usage: node scripts/verify.mjs <check> [args...]
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
const OUT_DIR = 'test-output';

export async function withApp(fn, { chromeArgs = [] } = {}) {
  mkdirSync(OUT_DIR, { recursive: true });
  const vite = spawn('node', ['node_modules/vite/bin/vite.js', '--port', '5199', '--strictPort'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let viteOut = '';
  vite.stdout.on('data', (d) => (viteOut += d));
  vite.stderr.on('data', (d) => (viteOut += d));
  try {
    // Poll the port rather than parsing vite's (ANSI-colored) banner.
    await waitFor(
      () => fetch('http://localhost:5199').then((r) => r.ok, () => false),
      15000,
      `vite start (output so far: ${viteOut.slice(0, 200)})`,
    );
    const browser = await chromium.launch({
      executablePath: CHROME,
      args: [
        '--no-sandbox',
        '--autoplay-policy=no-user-gesture-required',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        ...chromeArgs,
      ],
    });
    try {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(`console: ${m.text()}`);
      });
      await page.goto('http://localhost:5199', { waitUntil: 'networkidle' });
      await fn(page, { errors });
      if (errors.length) {
        console.error('Page errors:\n' + errors.join('\n'));
        process.exitCode = 1;
      }
    } finally {
      await browser.close();
    }
  } finally {
    try {
      process.kill(-vite.pid, 'SIGTERM');
    } catch {
      vite.kill('SIGTERM');
    }
  }
}

export async function waitFor(cond, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/** Read pixel RGBA at canvas-internal coords from the preview canvas. */
export async function canvasPixel(page, x, y) {
  return page.evaluate(
    ([px, py]) => {
      const canvas = document.querySelector('[data-testid="preview-canvas"]');
      const ctx = canvas.getContext('2d');
      const d = ctx.getImageData(px, py, 1, 1).data;
      return [d[0], d[1], d[2], d[3]];
    },
    [x, y],
  );
}

export function shot(page, name) {
  return page.screenshot({ path: path.join(OUT_DIR, `${name}.png`) });
}

export function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${msg}`);
  }
}
