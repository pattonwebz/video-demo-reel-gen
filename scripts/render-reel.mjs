/**
 * D4 renderer: turn a recorded run (recording + telemetry + edits) into the
 * final MP4 by driving the studio app headlessly through window.__demoReel
 * (see docs-local/AUTOMATION-PLAN.md and docs-local/DEMO-SCRIPT.md).
 *
 * Usage:
 *   node scripts/render-reel.mjs --script <demo-script.yaml> --run <run-dir> \
 *        [-o out.mp4] [--local | --host [url]]
 *
 *   --script  demo script YAML; only `meta` is used here (canvas / export /
 *             music — music path resolves relative to the YAML file)
 *   --run     run directory from record-demo.mjs, containing
 *             recording.webm|.mp4 + telemetry.json + edits.json
 *   -o        output MP4 path (default: <run-dir>/out.mp4)
 *   --local   serve ./dist statically and render against it (default;
 *             requires `npm run build` first)
 *   --host    render against a deployed studio URL instead
 *             (bare --host defaults to the GitHub Pages deployment)
 *
 * Progress goes to stderr; the last stdout line is a machine-readable JSON
 * result: { ok, outPath, durationSec, width, height, videoCodec, audioCodec,
 * hasAudio, audioMix, timelineMs, titleCards, captions, explicitZooms,
 * autoZoomsAdded }. audioMix is 'in-page' when the browser encoded the AAC
 * mix itself, 'ffmpeg' when this script mixed/muxed it (Linux Chrome has no
 * WebCodecs AAC encoder), or null for a silent reel.
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { parse as parseYaml } from 'yaml';

const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
const PAGES_URL = 'https://pattonwebz.github.io/video-demo-reel-gen/';
/** Must match `base` in vite.config.ts — dist assets are rooted here. */
const BASE_PATH = '/video-demo-reel-gen/';
/** Origin-relative prefix the page fetches run assets from (route-intercepted). */
const ASSET_PREFIX = '/__demoreel/';
/** Matches the store's MIN_CLIP_SOURCE_MS — no split may leave a shorter sliver. */
const MIN_CLIP_SOURCE_MS = 100;

const log = (...a) => console.error('[render-reel]', ...a);

function fail(msg) {
  console.error(`render-reel: ${msg}`);
  console.log(JSON.stringify({ ok: false, error: msg }));
  process.exit(1);
}

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const args = { mode: 'local', host: PAGES_URL };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--script') args.script = argv[++i];
    else if (a === '--run') args.run = argv[++i];
    else if (a === '-o' || a === '--out') args.out = argv[++i];
    else if (a === '--local') args.mode = 'local';
    else if (a === '--host') {
      args.mode = 'host';
      if (argv[i + 1] && !argv[i + 1].startsWith('-')) args.host = argv[++i];
    } else fail(`unknown argument: ${a}`);
  }
  if (!args.script) fail('missing --script <demo-script.yaml>');
  if (!args.run) fail('missing --run <run-dir>');
  args.out = path.resolve(args.out ?? path.join(args.run, 'out.mp4'));
  return args;
}

// ------------------------------------------------------------------- inputs

function readJson(file, label) {
  if (!existsSync(file)) fail(`${label} not found: ${file}`);
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    fail(`${label} is not valid JSON (${file}): ${e.message}`);
  }
}

function loadInputs(args) {
  const scriptPath = path.resolve(args.script);
  if (!existsSync(scriptPath)) fail(`demo script not found: ${scriptPath}`);
  let script;
  try {
    script = parseYaml(readFileSync(scriptPath, 'utf8'));
  } catch (e) {
    fail(`could not parse demo script YAML: ${e.message}`);
  }
  const meta = script?.meta ?? {};

  const runDir = path.resolve(args.run);
  const recordingPath = ['recording.webm', 'recording.mp4']
    .map((n) => path.join(runDir, n))
    .find(existsSync);
  if (!recordingPath) fail(`no recording.webm or recording.mp4 in ${runDir}`);

  const telemetry = readJson(path.join(runDir, 'telemetry.json'), 'telemetry.json');
  if (!Array.isArray(telemetry)) fail('telemetry.json must be an array of PointerSample');
  for (const s of telemetry) {
    if (typeof s?.t !== 'number' || typeof s?.x !== 'number' || typeof s?.y !== 'number'
        || (s.kind !== 'move' && s.kind !== 'click')) {
      fail(`telemetry.json contains a malformed sample: ${JSON.stringify(s)}`);
    }
  }

  const edits = readJson(path.join(runDir, 'edits.json'), 'edits.json');
  edits.titles ??= [];
  edits.captions ??= [];
  edits.zooms ??= [];
  for (const t of edits.titles) {
    if (typeof t?.atMs !== 'number' || typeof t?.heading !== 'string') {
      fail(`edits.json title is malformed (needs atMs + heading): ${JSON.stringify(t)}`);
    }
  }
  for (const c of edits.captions) {
    if (typeof c?.startMs !== 'number' || typeof c?.endMs !== 'number' || typeof c?.text !== 'string') {
      fail(`edits.json caption is malformed (needs startMs/endMs/text): ${JSON.stringify(c)}`);
    }
  }
  for (const z of edits.zooms) {
    if (typeof z?.startMs !== 'number' || typeof z?.endMs !== 'number'
        || typeof z?.cx !== 'number' || typeof z?.cy !== 'number') {
      fail(`edits.json zoom is malformed (needs startMs/endMs/cx/cy): ${JSON.stringify(z)}`);
    }
  }

  let musicPath = null;
  if (meta.music?.path) {
    musicPath = path.resolve(path.dirname(scriptPath), meta.music.path);
    if (!existsSync(musicPath)) fail(`music file not found: ${musicPath}`);
  }

  return { meta, recordingPath, telemetry, edits, musicPath };
}

// ------------------------------------------------- local static file server

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.map': 'application/json', '.wasm': 'application/wasm',
  '.woff2': 'font/woff2', '.webm': 'video/webm', '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg',
};

/** Serve dist/ under BASE_PATH (mirroring the Pages layout). Resolves to a base URL. */
function serveDist(distDir) {
  const server = createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (p.startsWith(BASE_PATH)) p = p.slice(BASE_PATH.length);
    else p = p.replace(/^\//, '');
    if (p === '' || p.endsWith('/')) p += 'index.html';
    const file = path.resolve(distDir, p);
    if (!file.startsWith(path.resolve(distDir) + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}${BASE_PATH}` }));
  });
}

// -------------------------------------------------------- project assembly

/** Ids that mimic the store's newId() shape but cannot collide with in-page ones. */
function makeIdFactory() {
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let n = 0;
  return (prefix) => `${prefix}_${tag}_r${(n++).toString(36)}`;
}

/** Translate demo-script meta.canvas sugar into a real Partial<CanvasSettings>. */
function normalizeCanvasMeta(canvasMeta = {}) {
  const patch = { ...canvasMeta };
  if (typeof patch.preset === 'string') {
    const presets = {
      '16:9': [1920, 1080], 'square': [1080, 1080], '1:1': [1080, 1080],
      'vertical': [1080, 1920], '9:16': [1080, 1920],
    };
    const dims = presets[patch.preset.toLowerCase()];
    if (!dims) fail(`unknown canvas preset: ${patch.preset}`);
    [patch.width, patch.height] = dims;
    delete patch.preset;
  }
  if (typeof patch.chrome === 'string') patch.chrome = { style: patch.chrome };
  if (patch.background?.type === 'blur') {
    patch.background = {
      type: 'frame-blur',
      blurPx: patch.background.blurPx ?? 60,
      brightness: patch.background.brightness ?? 0.7,
    };
  }
  return patch;
}

/**
 * Build the final Project document from the just-imported project snapshot.
 *
 * Time mapping: edits.json timestamps are recording-relative; title cards
 * inserted at recording time `atMs` push everything at-or-after that point
 * later on the timeline by their duration. So
 *   timelineMs(recMs) = recMs + Σ card.durationMs for cards with atMs <= recMs
 * (strict `<` for END timestamps, so a span ending exactly at a split point
 * closes before the card rather than stretching across it). All clip segments
 * run at speed 1, so the mapping is a pure offset.
 */
function buildProjectDoc(snapshot, edits, meta) {
  const doc = structuredClone(snapshot);
  const imported = [...doc.timeline].reverse().find((c) => c.sourceId !== null);
  if (!imported) fail('no imported clip found on the timeline after importRecording');
  const source = doc.sources[imported.sourceId];
  const recDur = source.durationMs;
  const newId = makeIdFactory();

  // Canvas first (defaultDriftPct feeds the zoom entries below).
  doc.canvas = { ...doc.canvas, ...normalizeCanvasMeta(meta.canvas) };

  // Titles: clamp into the recording, snap near-edge ones onto the edge so no
  // split leaves a < MIN_CLIP_SOURCE_MS sliver (matches store split rules).
  const titles = edits.titles
    .map((t) => {
      let atMs = Math.max(0, Math.min(recDur, t.atMs));
      if (atMs < MIN_CLIP_SOURCE_MS) atMs = 0;
      if (atMs > recDur - MIN_CLIP_SOURCE_MS) atMs = recDur;
      return { atMs, heading: t.heading, sub: t.sub, durationMs: Math.max(500, t.durationMs ?? 3000) };
    })
    .sort((a, b) => a.atMs - b.atMs); // stable: same-atMs titles keep author order

  // Distinct split points strictly inside the recording; merge near-identical ones.
  const splitPoints = [];
  for (const t of titles) {
    if (t.atMs <= 0 || t.atMs >= recDur) continue;
    const prev = splitPoints[splitPoints.length - 1];
    if (prev !== undefined && t.atMs - prev < MIN_CLIP_SOURCE_MS) t.atMs = prev;
    else splitPoints.push(t.atMs);
  }

  const cardEntry = (t) => ({
    id: newId('tl'),
    sourceId: null,
    inMs: 0,
    outMs: t.durationMs,
    speed: 1,
    card: { heading: t.heading, ...(t.sub != null ? { sub: t.sub } : {}), durationMs: t.durationMs },
  });

  // Timeline: leading cards, then recording segments with mid/trailing cards
  // attached after the segment that ends at their atMs.
  const timeline = titles.filter((t) => t.atMs === 0).map(cardEntry);
  const bounds = [0, ...splitPoints, recDur];
  for (let i = 0; i < bounds.length - 1; i++) {
    timeline.push({
      id: i === 0 ? imported.id : newId('tl'),
      sourceId: imported.sourceId,
      inMs: bounds[i],
      outMs: bounds[i + 1],
      speed: 1,
    });
    for (const t of titles) if (t.atMs > 0 && t.atMs === bounds[i + 1]) timeline.push(cardEntry(t));
  }
  doc.timeline = timeline;

  const totalMs = recDur + titles.reduce((s, t) => s + t.durationMs, 0);
  const mapTime = (recMs, isEnd = false) => {
    let shift = 0;
    for (const t of titles) if (isEnd ? t.atMs < recMs : t.atMs <= recMs) shift += t.durationMs;
    return Math.max(0, Math.min(totalMs, recMs + shift));
  };

  doc.captions = [
    ...doc.captions,
    ...edits.captions
      .map((c) => ({ id: newId('cap'), startMs: mapTime(c.startMs), endMs: mapTime(c.endMs, true), text: c.text }))
      .filter((c) => c.endMs > c.startMs),
  ];

  const explicitZoomIds = [];
  for (const z of edits.zooms) {
    const seg = {
      id: newId('zoom'),
      startMs: mapTime(z.startMs),
      endMs: mapTime(z.endMs, true),
      rampMs: z.rampMs ?? 500,
      cx: z.cx,
      cy: z.cy,
      zoom: z.zoom ?? 2,
      driftPct: doc.canvas.defaultDriftPct ?? 0,
    };
    if (seg.endMs <= seg.startMs) continue;
    explicitZoomIds.push(seg.id);
    doc.zooms.push(seg);
  }
  doc.zooms.sort((a, b) => a.startMs - b.startMs);

  return { doc, totalMs, explicitZoomIds, titles };
}

// ------------------------------------- ffmpeg audio fallback (no AAC encode)

/**
 * Linux Chrome has no WebCodecs AAC *encoder*, and the app's export mixes
 * audio through AudioBufferSource({ codec: 'aac' }) whenever the timeline has
 * more than one entry or music is set — which an assembled reel always does.
 * When the in-page encoder probe fails we export video-only (see
 * suppressInPageAudio) and rebuild the same mix here with ffmpeg: each
 * recording segment's trim window placed at its timeline position, music
 * looped across the whole timeline with gain + linear fades — mirroring
 * prepareAudioMix in src/engine/export.ts.
 */
function ffprobeJson(file) {
  return JSON.parse(execFileSync('ffprobe', [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
  ]).toString());
}

function hasAudioStream(file) {
  try {
    return ffprobeJson(file).streams.some((s) => s.codec_type === 'audio');
  } catch {
    return false;
  }
}

/** Mux an AAC track (segments + music mix) onto a video-only MP4. False if silent. */
function muxAudioWithFfmpeg({ videoPath, recordingPath, segments, music, totalMs, outPath }) {
  const totalS = totalMs / 1000;
  const inputs = ['-i', videoPath];
  const filters = [];
  const labels = [];
  let nextInput = 1;

  // Every chain is padded/trimmed to exactly totalS so amix's dynamic 1/N
  // weighting stays constant (this ffmpeg 4.2 has no amix normalize option);
  // a volume=N stage after amix then restores the plain sum WebAudio produces.
  const toFullLength = `apad,atrim=0:${totalS}`;

  if (segments.length > 0 && hasAudioStream(recordingPath)) {
    const recIdx = nextInput++;
    inputs.push('-i', recordingPath);
    segments.forEach((s, i) => {
      const delay = Math.round(s.delayMs);
      filters.push(
        `[${recIdx}:a]atrim=start=${s.inMs / 1000}:end=${s.outMs / 1000},asetpts=PTS-STARTPTS,` +
        // Per-channel delay list (4.2 lacks adelay's `all` option); aformat
        // forces stereo just before, so two entries cover it.
        `aresample=48000,aformat=channel_layouts=stereo,adelay=${delay}|${delay},${toFullLength}[s${i}]`,
      );
      labels.push(`[s${i}]`);
    });
  }
  if (music) {
    const musIdx = nextInput++;
    inputs.push('-stream_loop', '-1', '-i', music.path);
    // Same defaults + half-duration clamp as the store/export mix path.
    const gain = music.gain ?? 0.6;
    const fadeIn = Math.min((music.fadeInMs ?? 500) / 1000, totalS / 2);
    const fadeOut = Math.min((music.fadeOutMs ?? 1000) / 1000, totalS / 2);
    let chain =
      `[${musIdx}:a]aresample=48000,aformat=channel_layouts=stereo,` +
      `atrim=0:${totalS},asetpts=PTS-STARTPTS,volume=${gain}`;
    if (fadeIn > 0) chain += `,afade=t=in:st=0:d=${fadeIn}`;
    if (fadeOut > 0) chain += `,afade=t=out:st=${totalS - fadeOut}:d=${fadeOut}`;
    filters.push(`${chain},${toFullLength}[m]`);
    labels.push('[m]');
  }
  if (labels.length === 0) return false;

  let mapLabel = labels[0];
  if (labels.length > 1) {
    filters.push(
      `${labels.join('')}amix=inputs=${labels.length}:duration=longest:dropout_transition=0,` +
      `volume=${labels.length},atrim=0:${totalS}[aout]`,
    );
    mapLabel = '[aout]';
  }
  execFileSync('ffmpeg', [
    '-y', '-v', 'error', ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '0:v', '-map', mapLabel,
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
    outPath,
  ], { stdio: ['ignore', 'inherit', 'inherit'] });
  return true;
}

/**
 * Return a copy of the project whose export takes no in-page audio path:
 * music removed, and source clips nudged to speed 1.000001 — the mix path
 * only takes speed===1 clips as audio contributors, and a 1e-6 speed change
 * shifts frame sampling by microseconds over a whole demo (invisible).
 */
function suppressInPageAudio(doc) {
  const copy = structuredClone(doc);
  delete copy.music;
  for (const c of copy.timeline) if (c.sourceId !== null && c.speed === 1) c.speed = 1.000001;
  return copy;
}

// -------------------------------------------------------------------- main

const cleanups = [];
async function cleanup() {
  for (const fn of cleanups.splice(0)) {
    try { await fn(); } catch { /* best effort */ }
  }
}
process.on('SIGINT', async () => {
  log('interrupted, cleaning up…');
  await cleanup();
  process.exit(130);
});

const args = parseArgs(process.argv.slice(2));
const { meta, recordingPath, telemetry, edits, musicPath } = loadInputs(args);

let baseUrl = args.host;
if (args.mode === 'local') {
  const distDir = path.resolve(import.meta.dirname, '../dist');
  if (!existsSync(path.join(distDir, 'index.html'))) {
    fail(`no build at ${distDir} — run \`npm run build\` first (or use --host)`);
  }
  const { server, baseUrl: url } = await serveDist(distDir);
  cleanups.push(() => new Promise((r) => server.close(r)));
  baseUrl = url;
}
log(`render host: ${baseUrl} (${args.mode})`);

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
cleanups.push(() => browser.close());

try {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const pageProblems = [];
  page.on('pageerror', (e) => pageProblems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') pageProblems.push(`console: ${m.text()}`); });

  // Run assets (recording, music) reach the page through route interception on
  // an origin-relative fake path — works identically for --local and --host,
  // and never base64s the (potentially ~100MB) recording through evaluate.
  const recName = path.basename(recordingPath);
  const assets = new Map([
    [recName, { path: recordingPath, type: MIME[path.extname(recordingPath)] ?? 'video/webm' }],
  ]);
  if (musicPath) {
    assets.set(path.basename(musicPath), { path: musicPath, type: MIME[path.extname(musicPath)] ?? 'audio/mpeg' });
  }
  await context.route(`**${ASSET_PREFIX}*`, (route) => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop());
    const asset = assets.get(name);
    if (asset) return route.fulfill({ path: asset.path, contentType: asset.type });
    return route.fulfill({ status: 404, body: `unknown asset ${name}` });
  });

  const sep = baseUrl.includes('?') ? '&' : '?';
  await page.goto(`${baseUrl}${sep}automation=1`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForFunction(() => window.__demoReel?.ready === true, null, { timeout: 30000 })
    .catch(() => fail(`window.__demoReel not present on ${baseUrl} — is the automation API deployed there?`));
  // Let the startup OPFS restore settle before we start mutating the store.
  await page.waitForTimeout(300);

  // The app's audio mix path encodes AAC via WebCodecs; Linux Chrome can
  // decode but not encode AAC, so probe up front and fall back to an
  // ffmpeg-side mix when the in-page encoder is unavailable.
  const aacEncodeOk = await page.evaluate(() =>
    typeof AudioEncoder !== 'undefined'
      ? AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 })
          .then((s) => s.supported === true, () => false)
      : false,
  );
  if (!aacEncodeOk) log('no in-page AAC encoder — audio will be mixed with ffmpeg after export');

  log(`importing ${recName} + ${telemetry.length} telemetry samples…`);
  const sourceId = await page.evaluate(async ({ prefix, name, telemetry }) => {
    const res = await fetch(`${prefix}${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error(`asset fetch ${name}: HTTP ${res.status}`);
    const blob = await res.blob();
    return window.__demoReel.importRecording(blob, telemetry, name);
  }, { prefix: ASSET_PREFIX, name: recName, telemetry });
  log(`imported source ${sourceId}`);

  // Read-modify-write: snapshot the project, assemble the full document in
  // Node (titles/splits, remapped captions + explicit zooms, canvas), push back.
  const snapshot = await page.evaluate(() => window.__demoReel.getProject());
  const { doc, totalMs, explicitZoomIds, titles } = buildProjectDoc(snapshot, edits, meta);
  await page.evaluate((p) => window.__demoReel.loadProject(p), doc);
  log(`timeline assembled: ${doc.timeline.length} entries (${titles.length} title cards), ${Math.round(totalMs)}ms total`);

  // Auto-zoom every recording segment; the store skips spans already covered
  // by the explicit zooms we loaded, so explicit ones win.
  const clipIds = doc.timeline.filter((c) => c.sourceId !== null).map((c) => c.id);
  const autoCounts = await page.evaluate(
    (ids) => ids.map((id) => window.__demoReel.autoZoomClip(id)),
    clipIds,
  );
  const autoZoomsAdded = autoCounts.reduce((a, b) => a + b, 0);

  const after = await page.evaluate(() => window.__demoReel.getProject());
  const survivingExplicit = explicitZoomIds.filter((id) => after.zooms.some((z) => z.id === id));
  if (survivingExplicit.length !== explicitZoomIds.length) {
    fail(`explicit zooms lost in assembly: expected ${explicitZoomIds.length}, found ${survivingExplicit.length}`);
  }
  log(`zooms: ${explicitZoomIds.length} explicit + ${autoZoomsAdded} auto = ${after.zooms.length} total`);

  if (musicPath && aacEncodeOk) {
    const m = meta.music;
    await page.evaluate(async ({ prefix, name, opts }) => {
      const res = await fetch(`${prefix}${encodeURIComponent(name)}`);
      if (!res.ok) throw new Error(`asset fetch ${name}: HTTP ${res.status}`);
      await window.__demoReel.setMusic(await res.blob(), opts);
    }, {
      prefix: ASSET_PREFIX,
      name: path.basename(musicPath),
      opts: {
        name: path.basename(musicPath),
        ...(m.gain != null ? { gain: m.gain } : {}),
        ...(m.fadeInMs != null ? { fadeInMs: m.fadeInMs } : {}),
        ...(m.fadeOutMs != null ? { fadeOutMs: m.fadeOutMs } : {}),
      },
    });
    log(`music set: ${path.basename(musicPath)}`);
  }

  if (!aacEncodeOk) {
    // Re-push the post-autoZoom document with the in-page audio path disabled;
    // export then produces video-only and ffmpeg supplies the audio below.
    await page.evaluate((p) => window.__demoReel.loadProject(p), suppressInPageAudio(after));
  }

  const exportOpts = {};
  for (const k of ['fps', 'scale', 'motionBlur', 'videoBitrate']) {
    if (meta.export?.[k] != null) exportOpts[k] = meta.export[k];
  }
  // Exports run well below realtime (~10fps of 30fps content at 1080p):
  // allow 10x content duration plus slack, more when scaled up.
  const exportTimeout = 120000 + totalMs * 10 * (exportOpts.scale ?? 1) ** 2;
  log(`exporting (${JSON.stringify(exportOpts)}, timeout ${Math.round(exportTimeout / 1000)}s)…`);
  const downloadPromise = page.waitForEvent('download', { timeout: exportTimeout });
  const exportDone = page.evaluate((opts) => window.__demoReel.exportMp4(opts), exportOpts);
  const download = await Promise.race([downloadPromise, exportDone.then(() => downloadPromise)]);
  await exportDone;

  let audioMix = aacEncodeOk ? 'in-page' : 'ffmpeg';
  if (aacEncodeOk) {
    await download.saveAs(args.out);
  } else {
    const videoOnly = `${args.out}.videoonly.mp4`;
    await download.saveAs(videoOnly);
    // Timeline positions of the recording segments, for placing their audio.
    const segments = [];
    let cursorMs = 0;
    for (const c of doc.timeline) {
      const durMs = c.sourceId === null ? (c.card?.durationMs ?? 0) / c.speed : (c.outMs - c.inMs) / c.speed;
      if (c.sourceId !== null) segments.push({ delayMs: cursorMs, inMs: c.inMs, outMs: c.outMs });
      cursorMs += durMs;
    }
    const mixed = muxAudioWithFfmpeg({
      videoPath: videoOnly,
      recordingPath,
      segments,
      music: musicPath ? { ...meta.music, path: musicPath } : null,
      totalMs,
      outPath: args.out,
    });
    if (mixed) {
      rmSync(videoOnly, { force: true });
      log('audio mixed and muxed with ffmpeg');
    } else {
      rmSync(args.out, { force: true });
      execFileSync('mv', [videoOnly, args.out]);
      audioMix = null; // nothing had audio — video-only output
    }
  }
  log(`saved ${args.out}`);

  if (pageProblems.length) log(`page reported problems:\n  ${pageProblems.join('\n  ')}`);

  let probe = null;
  try {
    probe = ffprobeJson(args.out);
  } catch (e) {
    log(`ffprobe unavailable/failed: ${e.message}`);
  }
  const video = probe?.streams?.find((s) => s.codec_type === 'video');
  const audio = probe?.streams?.find((s) => s.codec_type === 'audio');
  console.log(JSON.stringify({
    ok: true,
    outPath: args.out,
    durationSec: probe ? Number(probe.format.duration) : null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    hasAudio: audio != null,
    audioMix,
    timelineMs: Math.round(totalMs),
    titleCards: titles.length,
    captions: after.captions.length,
    explicitZooms: explicitZoomIds.length,
    autoZoomsAdded,
  }));
} catch (e) {
  await cleanup();
  fail(e?.message ?? String(e));
}
await cleanup();
