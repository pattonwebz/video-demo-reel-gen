/**
 * Demo recording runner (AUTOMATION-PLAN.md deliverable D3).
 *
 * Executes a demo-script.yaml move set (see docs-local/DEMO-SCRIPT.md) in
 * headless system Chrome via playwright-core, captures pixels with CDP
 * Page.startScreencast (no Xvfb/x11grab needed), synthesizes pointer
 * telemetry indistinguishable from the bookmarklet's, and writes a run dir:
 *
 *   recording.mp4  — clean CFR 30fps H.264 (cursor-free; the studio's
 *                    compositor draws the synthetic cursor from telemetry)
 *   telemetry.json — PointerSample[] ({t,x,y,kind}, coords 0–1, t=0 at the
 *                    first captured frame)
 *   edits.json     — { titles, captions, zooms } for scripts/render-reel.mjs
 *   run.log        — step-by-step timing log
 *
 * Clock discipline: t=0 for telemetry, edits AND the video is the first
 * screencast frame's CDP metadata.timestamp (epoch-based, same wall clock as
 * Date.now()). Every step/telemetry timestamp is Date.now() rebased onto it;
 * every frame's presentation time in the mp4 is its own metadata.timestamp
 * rebased onto it. One clock, one origin — video time == telemetry time.
 *
 * Usage: node scripts/record-demo.mjs <demo-script.yaml> [--out-dir runs/] [--keep-frames]
 * Exit codes: 0 ok · 1 run failure (failure.png + run.log kept, no outputs) · 2 validation/usage error.
 */
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import Ajv2020Mod from 'ajv/dist/2020.js';
import addFormatsMod from 'ajv-formats';

const Ajv2020 = Ajv2020Mod.default ?? Ajv2020Mod;
const addFormats = addFormatsMod.default ?? addFormatsMod;

const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
const SCHEMA_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'docs-local',
  'demo-script.schema.json',
);

const DEFAULTS = {
  viewport: { width: 1280, height: 800 },
  selectorTimeout: 5000,
  hoverDwell: 800,
  typeDelay: 80,
  titleDuration: 2500,
  zoomHold: 2000,
  zoomRamp: 500,
  pressMs: 120,
  gotoSettle: 500,
  endPad: 400, // trailing capture so the last action's frames land
};

// ---------------------------------------------------------------- CLI

function usage(msg) {
  if (msg) console.error(msg);
  console.error('usage: node scripts/record-demo.mjs <demo-script.yaml> [--out-dir runs/] [--keep-frames]');
  process.exit(2);
}

const argv = process.argv.slice(2);
let scriptPath = null;
let outRoot = 'runs';
let keepFrames = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--out-dir') outRoot = argv[++i] ?? usage('--out-dir needs a value');
  else if (a === '--keep-frames') keepFrames = true;
  else if (a.startsWith('--')) usage(`unknown flag: ${a}`);
  else if (!scriptPath) scriptPath = a;
  else usage(`unexpected argument: ${a}`);
}
if (!scriptPath) usage();

// ---------------------------------------------------------------- load + validate (before any browser work)

let script;
try {
  script = YAML.parse(fs.readFileSync(scriptPath, 'utf8'));
} catch (e) {
  console.error(`Failed to read/parse ${scriptPath}: ${e.message}`);
  process.exit(2);
}
{
  const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true });
  addFormats(ajv);
  const validate = ajv.compile(JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8')));
  if (!validate(script)) {
    console.error(`Schema validation failed for ${scriptPath}:`);
    for (const err of validate.errors ?? []) {
      console.error(`  ${err.instancePath || '(root)'} ${err.message}${err.params?.allowedValues ? ` (${JSON.stringify(err.params.allowedValues)})` : ''}`);
    }
    process.exit(2);
  }
}

const meta = script.meta;
const vw = meta.viewport?.width ?? DEFAULTS.viewport.width;
const vh = meta.viewport?.height ?? DEFAULTS.viewport.height;
const steps = script.steps.map((raw) =>
  raw === 'endCaption' ? { kind: 'endCaption', payload: null } : { kind: Object.keys(raw)[0], payload: raw[Object.keys(raw)[0]] },
);

if (meta.music?.path) {
  const musicAbs = path.resolve(path.dirname(path.resolve(scriptPath)), meta.music.path);
  if (!fs.existsSync(musicAbs)) {
    console.error(`warning: meta.music.path not found: ${musicAbs} (renderer will fail to attach music)`);
  }
}

// ---------------------------------------------------------------- run dir

const stamp = (() => {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
})();
const runDir = path.resolve(outRoot, `${meta.name}-${stamp}`);
const framesDir = path.join(runDir, 'frames');
fs.mkdirSync(framesDir, { recursive: true });

// ---------------------------------------------------------------- shared state

let captureStartMs = null; // epoch ms of first screencast frame == t=0 everywhere
const relNow = () => Date.now() - captureStartMs;
const samples = []; // PointerSample[]
const edits = { titles: [], captions: [], zooms: [] };
let openCaption = null;
const logLines = [];
const cursor = { x: vw / 2, y: vh / 2 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const easeInOutCubic = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

function log(msg) {
  const at = captureStartMs == null ? '  pre-roll' : `+${String(Math.round(relNow())).padStart(7)}ms`;
  const line = `[${at}] ${msg}`;
  logLines.push(line);
  console.log(line);
}

function sample(kind, xPx, yPx) {
  if (captureStartMs == null) return;
  const t = relNow();
  if (t < 0) return; // mirror TelemetryReceiver: drop pre-capture samples
  samples.push({ t: Math.round(t), x: clamp(xPx / vw, 0, 1), y: clamp(yPx / vh, 0, 1), kind });
}

function closeCaption(atMs) {
  if (!openCaption) return false;
  edits.captions.push({ startMs: openCaption.startMs, endMs: Math.round(atMs), text: openCaption.text });
  openCaption = null;
  return true;
}

function writeRunLog() {
  const header = [
    `# record-demo run — ${meta.name}`,
    `script: ${path.resolve(scriptPath)}`,
    `url: ${meta.url}`,
    `viewport: ${vw}x${vh}`,
    `captureStartEpochMs: ${captureStartMs ?? 'n/a'}`,
    '',
  ];
  fs.writeFileSync(path.join(runDir, 'run.log'), header.concat(logLines, '').join('\n'));
}

// ---------------------------------------------------------------- browser + screencast

let browser = null;
let interrupted = false;
process.on('SIGINT', () => {
  interrupted = true;
  log('SIGINT — aborting');
  fs.rmSync(framesDir, { recursive: true, force: true });
  writeRunLog();
  const b = browser;
  browser = null;
  Promise.resolve(b?.close().catch(() => {})).finally(() => process.exit(130));
});

async function main() {
  browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on('dialog', (d) => d.dismiss().catch(() => {}));

  // -- screencast plumbing ------------------------------------------------
  const cdp = await context.newCDPSession(page);
  const frames = []; // { file, tMs (epoch) }
  const frameWrites = [];
  let lastFrameTs = -Infinity;
  cdp.on('Page.screencastFrame', (ev) => {
    // Ack immediately so Chrome keeps the frames coming.
    cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {});
    const tsMs = (ev.metadata?.timestamp ?? Date.now() / 1000) * 1000;
    if (tsMs <= lastFrameTs) return; // enforce monotonic presentation times
    lastFrameTs = tsMs;
    const file = path.join(framesDir, `f${String(frames.length).padStart(6, '0')}.png`);
    frames.push({ file, tMs: tsMs });
    frameWrites.push(fsp.writeFile(file, Buffer.from(ev.data, 'base64')));
  });

  /** Force compositor damage so a screencast frame is produced on demand. */
  const nudgeFrame = () =>
    page
      .evaluate(
        () =>
          new Promise((resolve) => {
            const d = document.createElement('div');
            d.style.cssText =
              'position:fixed;left:0;top:0;width:2px;height:2px;background:rgba(127,127,127,0.02);z-index:2147483647;pointer-events:none';
            document.documentElement.appendChild(d);
            requestAnimationFrame(() => {
              d.remove();
              requestAnimationFrame(() => resolve(undefined));
            });
          }),
      )
      .catch(() => {});

  // -- cursor synthesis ---------------------------------------------------

  async function moveMouse(x, y) {
    await page.mouse.move(x, y);
    cursor.x = x;
    cursor.y = y;
  }

  /**
   * Eased cursor travel per the DEMO-SCRIPT.md synthesis contract: cubic
   * ease-in-out, 600–900ms scaled by distance ±10% jitter, 2–4px of
   * perpendicular wobble, move samples at 50–70ms cadence. The real mouse is
   * driven along the exact sampled path so hover states match telemetry.
   */
  async function travelTo(tx, ty) {
    const sx = cursor.x;
    const sy = cursor.y;
    const dx = tx - sx;
    const dy = ty - sy;
    const dist = Math.hypot(dx, dy);
    if (dist < 2) {
      await moveMouse(tx, ty);
      sample('move', tx, ty);
      return;
    }
    const diag = Math.hypot(vw, vh);
    const base = 600 + 300 * Math.min(1, dist / (diag * 0.6));
    const dur = base * rand(0.9, 1.1);
    const amp = rand(2, 4);
    const waves = Math.random() < 0.6 ? 1 : 2; // sin(kπp) is 0 at both endpoints
    const px = -dy / dist;
    const py = dx / dist;
    const t0 = Date.now();
    for (;;) {
      const elapsed = Date.now() - t0;
      if (elapsed >= dur) break;
      const e = easeInOutCubic(elapsed / dur);
      const wob = Math.sin((elapsed / dur) * Math.PI * waves) * amp;
      const x = sx + dx * e + px * wob;
      const y = sy + dy * e + py * wob;
      await moveMouse(x, y);
      sample('move', x, y);
      await sleep(rand(50, 70));
    }
    await moveMouse(tx, ty);
    sample('move', tx, ty);
  }

  /** Window-scroll by deltaY with easing; emits move samples tracking a reference point. */
  async function animateScroll(deltaY, speed = 'normal', trackEl = null) {
    if (!deltaY) return;
    const pxPerMs = { slow: 0.45, normal: 0.9, fast: 1.6 }[speed] ?? 0.9;
    const dur = clamp(Math.abs(deltaY) / pxPerMs, 300, 4000);
    let applied = 0;
    const t0 = Date.now();
    for (;;) {
      const elapsed = Math.min(Date.now() - t0, dur);
      const want = Math.round(deltaY * easeInOutCubic(elapsed / dur));
      if (want !== applied) {
        await page.evaluate((s) => window.scrollBy(0, s), want - applied);
        applied = want;
      }
      // Cursor follows a reference point so the smoothed cursor tracks the motion.
      let rx = cursor.x + rand(-1, 1);
      let ry = cursor.y + rand(-1, 1);
      if (trackEl) {
        const box = await trackEl.boundingBox().catch(() => null);
        if (box) {
          const tx = clamp(box.x + box.width / 2, 24, vw - 24);
          const ty = clamp(box.y + box.height / 2, 24, vh - 24);
          rx = cursor.x + (tx - cursor.x) * 0.35;
          ry = cursor.y + (ty - cursor.y) * 0.35;
        }
      }
      await moveMouse(rx, ry);
      sample('move', rx, ry);
      if (elapsed >= dur) break;
      await sleep(rand(50, 68));
    }
  }

  /** Smooth-scroll the element into the viewport if it isn't comfortably there. */
  async function ensureInView(el) {
    const delta = await el.evaluate((node) => {
      const r = node.getBoundingClientRect();
      const margin = 24;
      if (r.top >= margin && r.bottom <= innerHeight - margin) return 0;
      const want = r.top + r.height / 2 - innerHeight / 2;
      const maxDown = Math.max(0, document.documentElement.scrollHeight - innerHeight - window.scrollY);
      return Math.round(Math.max(-window.scrollY, Math.min(maxDown, want)));
    });
    if (delta) await animateScroll(delta, 'normal', el);
  }

  async function resolveTarget(selector, timeout) {
    const el = await page.waitForSelector(selector, {
      state: 'visible',
      timeout: timeout ?? DEFAULTS.selectorTimeout,
    });
    await ensureInView(el);
    const box = await el.boundingBox();
    if (!box) throw new Error(`element has no bounding box: ${selector}`);
    return { el, box };
  }

  /** Human-ish point inside the element: near center with slight offset. */
  const pointIn = (box) => ({
    x: box.x + box.width * rand(0.42, 0.58),
    y: box.y + box.height * rand(0.42, 0.58),
  });

  async function pressAt(x, y, button, clickCount) {
    await page.mouse.down({ button, clickCount });
    await sleep(DEFAULTS.pressMs);
    await page.mouse.up({ button, clickCount });
    sample('click', x, y); // bookmarklet's click listener fires at release
  }

  const asObj = (payload, key = 'selector') => (typeof payload === 'string' ? { [key]: payload } : payload);

  // -- step executor ------------------------------------------------------

  async function runStep(step, index) {
    const p = step.payload;
    switch (step.kind) {
      case 'goto': {
        log(`goto ${p}`);
        await page.goto(p, { waitUntil: 'load', timeout: 30000 });
        await sleep(DEFAULTS.gotoSettle);
        break;
      }
      case 'click':
      case 'dblclick': {
        const { selector, timeout, button = 'left' } = asObj(p);
        const { box } = await resolveTarget(selector, timeout);
        const pt = pointIn(box);
        await travelTo(pt.x, pt.y);
        await sleep(rand(60, 140)); // settle before press
        await pressAt(pt.x, pt.y, button, 1);
        if (step.kind === 'dblclick') {
          await sleep(120);
          await pressAt(pt.x, pt.y, button, 2);
        }
        log(`${step.kind} ${selector} → (${(pt.x / vw).toFixed(3)}, ${(pt.y / vh).toFixed(3)})`);
        break;
      }
      case 'hover': {
        const { selector, timeout, dwell = DEFAULTS.hoverDwell } = asObj(p);
        const { box } = await resolveTarget(selector, timeout);
        const pt = pointIn(box);
        await travelTo(pt.x, pt.y);
        log(`hover ${selector} (dwell ${dwell}ms)`);
        await sleep(dwell);
        break;
      }
      case 'type': {
        const { selector, text, delay = DEFAULTS.typeDelay, timeout } = p;
        const { box } = await resolveTarget(selector, timeout);
        const pt = pointIn(box);
        await travelTo(pt.x, pt.y);
        await sleep(rand(60, 140));
        await pressAt(pt.x, pt.y, 'left', 1); // click to focus
        await sleep(rand(120, 220));
        for (const ch of text) {
          await page.keyboard.type(ch);
          await sleep(delay * rand(0.7, 1.3));
        }
        log(`type ${selector} "${text}"`);
        break;
      }
      case 'press': {
        await page.keyboard.press(p);
        log(`press ${p}`);
        break;
      }
      case 'scroll': {
        const { to, by, speed = 'normal' } = p;
        if (to) {
          const el = await page.waitForSelector(to, { state: 'visible', timeout: DEFAULTS.selectorTimeout });
          const delta = await el.evaluate((node) => {
            const r = node.getBoundingClientRect();
            const want = r.top + r.height / 2 - innerHeight / 2;
            const maxDown = Math.max(0, document.documentElement.scrollHeight - innerHeight - window.scrollY);
            return Math.round(Math.max(-window.scrollY, Math.min(maxDown, want)));
          });
          log(`scroll to ${to} (${delta}px, ${speed})`);
          await animateScroll(delta, speed, el);
        } else {
          log(`scroll by ${by}px (${speed})`);
          await animateScroll(by, speed, null);
        }
        break;
      }
      case 'wait': {
        log(`wait ${p}ms`);
        await sleep(p);
        break;
      }
      case 'title': {
        const entry = { atMs: Math.round(relNow()), heading: p.heading, durationMs: p.duration ?? DEFAULTS.titleDuration };
        if (p.sub) entry.sub = p.sub;
        edits.titles.push(entry);
        log(`title "${p.heading}"`);
        break;
      }
      case 'caption': {
        closeCaption(relNow());
        openCaption = { startMs: Math.round(relNow()), text: p };
        log(`caption open "${p}"`);
        break;
      }
      case 'endCaption': {
        if (!closeCaption(relNow())) log('endCaption: warning — no caption open');
        else log('caption closed');
        break;
      }
      case 'zoom': {
        const { selector, level, hold = DEFAULTS.zoomHold, ramp = DEFAULTS.zoomRamp, timeout } = p;
        const { box } = await resolveTarget(selector, timeout);
        const cx = clamp((box.x + box.width / 2) / vw, 0, 1);
        const cy = clamp((box.y + box.height / 2) / vh, 0, 1);
        const zoom =
          level ??
          +clamp(Math.min(vw / (box.width * 1.6), vh / (box.height * 1.6)), 1.2, 3).toFixed(2);
        const startMs = Math.round(relNow());
        edits.zooms.push({ startMs, endMs: startMs + hold, cx: +cx.toFixed(4), cy: +cy.toFixed(4), zoom, rampMs: ramp });
        log(`zoom ${selector} level=${zoom} @(${cx.toFixed(3)}, ${cy.toFixed(3)}) hold=${hold}ms`);
        await sleep(hold); // dwell so the zoom span has footage under it
        break;
      }
      default:
        throw new Error(`unknown step kind at steps[${index}]: ${step.kind}`);
    }
  }

  // -- run ------------------------------------------------------------------

  log(`pre-roll: navigate ${meta.url}`);
  await page.goto(meta.url, { waitUntil: 'load', timeout: 30000 });
  await sleep(DEFAULTS.gotoSettle);
  await moveMouse(cursor.x, cursor.y); // park the mouse before capture so hover state is settled

  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1, maxWidth: vw, maxHeight: vh });
  {
    const t0 = Date.now();
    let lastNudge = 0;
    while (frames.length === 0) {
      if (Date.now() - t0 > 10000) throw new Error('screencast produced no frames within 10s');
      if (Date.now() - lastNudge > 400) {
        lastNudge = Date.now();
        void nudgeFrame(); // fire-and-forget so the poll stays tight
      }
      await sleep(20);
    }
  }
  captureStartMs = frames[0].tMs;
  log(`capture started (first frame epoch ${captureStartMs.toFixed(1)}, skew vs now ${(Date.now() - captureStartMs).toFixed(0)}ms)`);
  sample('move', cursor.x, cursor.y); // anchor the cursor at t≈0

  let failure = null;
  try {
    for (let i = 0; i < steps.length; i++) {
      if (interrupted) throw new Error('interrupted');
      try {
        await runStep(steps[i], i);
      } catch (e) {
        e.message = `steps[${i}] ${steps[i].kind} ${JSON.stringify(steps[i].payload)}: ${e.message.split('\n')[0]}`;
        throw e;
      }
    }
    await sleep(DEFAULTS.endPad);
  } catch (e) {
    failure = e;
  }

  const endMs = relNow();
  await cdp.send('Page.stopScreencast').catch(() => {});
  await Promise.all(frameWrites);

  if (failure) {
    if (interrupted) {
      // SIGINT handler owns browser shutdown + exit(130); just persist the log.
      log('run interrupted (SIGINT)');
      fs.rmSync(framesDir, { recursive: true, force: true });
      writeRunLog();
      await new Promise(() => {}); // park until the handler exits the process
    }
    log(`FATAL: ${failure.message.split('\n')[0]}`);
    try {
      await page.screenshot({ path: path.join(runDir, 'failure.png') });
      log('failure screenshot saved: failure.png');
    } catch {}
    fs.rmSync(framesDir, { recursive: true, force: true });
    writeRunLog();
    await browser?.close();
    browser = null;
    console.error(`Run aborted: ${failure.message.split('\n')[0]}`);
    console.error(`See ${path.join(runDir, 'run.log')}`);
    process.exit(1);
  }

  closeCaption(endMs);
  await browser.close();
  browser = null;

  // -- assemble CFR 30fps video --------------------------------------------
  // Each frame holds from its own (rebased) timestamp until the next frame;
  // the last frame holds until end-of-run. fps=30 conforms that variable
  // timeline to constant frame rate by duplication.
  log(`assembling video from ${frames.length} frames (${Math.round(endMs)}ms)`);
  const concatLines = ['ffconcat version 1.0'];
  for (let i = 0; i < frames.length; i++) {
    const t = frames[i].tMs - captureStartMs;
    const next = i + 1 < frames.length ? frames[i + 1].tMs - captureStartMs : Math.max(endMs, t + 1000 / 30);
    concatLines.push(`file '${frames[i].file}'`, `duration ${Math.max(0.001, (next - t) / 1000).toFixed(6)}`);
  }
  concatLines.push(`file '${frames[frames.length - 1].file}'`); // concat-demuxer quirk: repeat last entry
  const listFile = path.join(framesDir, 'frames.txt');
  fs.writeFileSync(listFile, concatLines.join('\n') + '\n');

  const videoFile = path.join(runDir, 'recording.mp4');
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', listFile,
    '-vf', 'fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-pix_fmt', 'yuv420p',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
    '-movflags', '+faststart',
    videoFile,
  ]);
  if (!keepFrames) fs.rmSync(framesDir, { recursive: true, force: true });

  let videoDurationMs = null;
  try {
    const probe = JSON.parse(
      execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', videoFile]).toString(),
    );
    videoDurationMs = Math.round(Number(probe.format.duration) * 1000);
  } catch {}

  // -- write sidecars ------------------------------------------------------
  fs.writeFileSync(
    path.join(runDir, 'telemetry.json'),
    JSON.stringify(samples.map((s) => ({ t: s.t, x: +s.x.toFixed(4), y: +s.y.toFixed(4), kind: s.kind }))) + '\n',
  );
  fs.writeFileSync(path.join(runDir, 'edits.json'), JSON.stringify(edits, null, 2) + '\n');
  const clicks = samples.filter((s) => s.kind === 'click').length;
  log(`done: ${samples.length} samples (${clicks} clicks), ${edits.titles.length} titles, ${edits.captions.length} captions, ${edits.zooms.length} zooms`);
  writeRunLog();

  console.log(
    JSON.stringify({
      outDir: runDir,
      videoFile,
      durationMs: Math.round(endMs),
      videoDurationMs,
      samples: samples.length,
      clicks,
      edits: { titles: edits.titles.length, captions: edits.captions.length, zooms: edits.zooms.length },
    }),
  );
}

try {
  await main();
} catch (e) {
  if (interrupted) await new Promise(() => {}); // SIGINT handler owns exit(130)
  // Failures before/around the step loop (launch, pre-roll nav, screencast).
  log(`FATAL: ${e.message.split('\n')[0]}`);
  fs.rmSync(framesDir, { recursive: true, force: true });
  writeRunLog();
  try {
    await browser?.close();
  } catch {}
  console.error(`Run aborted: ${e.message.split('\n')[0]}`);
  process.exit(1);
}
