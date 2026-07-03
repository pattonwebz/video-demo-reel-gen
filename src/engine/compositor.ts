import type { Background, FrameChrome, Project, TitleCard } from './types';
import { backgroundImages } from './assets';
import { cameraAt, poseToSourceCrop } from './camera';
import { clipAt, clipDurationMs, transitionAt } from './timeline';
import { clamp, cubicInOut } from './easing';

export interface FrameSource {
  image: CanvasImageSource;
  width: number;
  height: number;
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where the video card sits on the canvas. `frameRect` is the rounded card
 * (shadow + clip target, includes any chrome); `videoRect` is where the video
 * pixels land. Identical when chrome is 'none'.
 */
export interface FrameLayout {
  frameRect: Rect;
  videoRect: Rect;
}

/** Chrome metrics scale with the shorter canvas edge (1 at 1080p). */
function chromeScale(W: number, H: number): number {
  return Math.min(W, H) / 1080;
}

function titleBarHeight(chrome: FrameChrome, W: number, H: number): number {
  return chrome.style === 'mac' || chrome.style === 'browser' ? Math.round(36 * chromeScale(W, H)) : 0;
}

function bezelWidth(chrome: FrameChrome, W: number, H: number): number {
  return chrome.style === 'phone' ? Math.round(14 * chromeScale(W, H)) : 0;
}

/**
 * Render one output frame. Pure with respect to inputs: the same
 * (project, timeMs, frame) always paints the same pixels, so preview and
 * export share this path.
 */
export function renderFrame(ctx: Ctx2D, project: Project, timeMs: number, frame: FrameSource | null): void {
  const { width: W, height: H } = project.canvas;
  paintBackground(ctx, project.canvas.background, W, H, frame);

  const hit = clipAt(project, timeMs);
  if (hit && hit.clip.sourceId === null && hit.clip.card) {
    // Title cards paint text straight on the background; their own entrance/
    // exit animation stands in for any dip transition at their boundaries.
    paintTitleCard(
      ctx,
      hit.clip.card,
      timeMs - hit.clipStartMs,
      clipDurationMs(hit.clip),
      W,
      H,
      project.canvas.background,
    );
    return;
  }
  if (!frame) return;

  // Dip transitions fade (and optionally shrink) the card into the
  // background around a clip boundary; at the cut itself it is invisible,
  // which also hides the preview's source-switch latency.
  let dipAlpha = 1;
  let dipScale = 1;
  const trans = transitionAt(project, timeMs);
  if (trans) {
    const e = cubicInOut(clamp(Math.abs(trans.p), 0, 1));
    dipAlpha = e;
    if (trans.type === 'dip-scale') dipScale = 0.85 + 0.15 * e;
    if (dipAlpha < 0.005) return;
  }

  let { frameRect, videoRect } = frameLayout(project, frame.width, frame.height);
  const { cornerRadius, shadow, chrome } = project.canvas;
  const s = chromeScale(W, H) * dipScale;
  if (dipScale !== 1) {
    const cx = frameRect.x + frameRect.w / 2;
    const cy = frameRect.y + frameRect.h / 2;
    frameRect = scaleRectAbout(frameRect, dipScale, cx, cy);
    videoRect = scaleRectAbout(videoRect, dipScale, cx, cy);
  }
  const baseRadius = chrome.style === 'phone' ? Math.max(cornerRadius, 40 * s) : cornerRadius * dipScale;
  const radius = Math.min(baseRadius, frameRect.w / 2, frameRect.h / 2);

  ctx.save();
  ctx.globalAlpha = dipAlpha;
  ctx.shadowColor = `rgba(0,0,0,${shadow.opacity})`;
  ctx.shadowBlur = shadow.blur;
  ctx.shadowOffsetY = shadow.offsetY;
  roundedRectPath(ctx, frameRect.x, frameRect.y, frameRect.w, frameRect.h, radius);
  ctx.fillStyle = chrome.style === 'phone' ? '#0b0d12' : '#000';
  ctx.fill();
  ctx.restore();

  const pose = cameraAt(project.zooms, timeMs);
  const crop = poseToSourceCrop(pose, frame.width, frame.height);

  ctx.save();
  roundedRectPath(ctx, frameRect.x, frameRect.y, frameRect.w, frameRect.h, radius);
  ctx.clip();
  paintChromeBar(ctx, chrome, frameRect, s);
  ctx.drawImage(frame.image, crop.sx, crop.sy, crop.sw, crop.sh, videoRect.x, videoRect.y, videoRect.w, videoRect.h);
  paintPhoneNotch(ctx, chrome, videoRect, s);
  paintVignette(ctx, project.canvas.zoomVignette, pose.zoom, videoRect);
  ctx.restore();
  ctx.restore();
}

function scaleRectAbout(r: Rect, scale: number, cx: number, cy: number): Rect {
  return { x: cx + (r.x - cx) * scale, y: cy + (r.y - cy) * scale, w: r.w * scale, h: r.h * scale };
}

const CARD_FONT = `-apple-system, 'Segoe UI', Roboto, sans-serif`;
const CARD_IN_MS = 500;
const CARD_OUT_MS = 300;

function paintTitleCard(
  ctx: Ctx2D,
  card: TitleCard,
  localMs: number,
  durMs: number,
  W: number,
  H: number,
  bg: Background,
): void {
  let alpha = 1;
  let rise = 0;
  if (localMs < CARD_IN_MS) {
    const u = cubicInOut(clamp(localMs / CARD_IN_MS, 0, 1));
    alpha = u;
    rise = (1 - u) * 20 * (H / 1080);
  } else if (durMs - localMs < CARD_OUT_MS) {
    alpha = cubicInOut(clamp((durMs - localMs) / CARD_OUT_MS, 0, 1));
  }

  // White text unless the background is a light solid.
  const color = bg.type === 'solid' && relativeLuminance(bg.color) > 0.6 ? '#16181d' : '#ffffff';

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const cy = H / 2 + rise;
  ctx.font = `600 ${Math.round(H * 0.07)}px ${CARD_FONT}`;
  ctx.fillText(card.heading, W / 2, card.sub ? cy - H * 0.03 : cy);
  if (card.sub) {
    ctx.globalAlpha = alpha * 0.7;
    ctx.font = `400 ${Math.round(H * 0.035)}px ${CARD_FONT}`;
    ctx.fillText(card.sub, W / 2, cy + H * 0.05);
  }
  ctx.restore();
}

/** Approximate relative luminance (0–1) of a #rrggbb color. */
function relativeLuminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  return (0.2126 * ((n >> 16) & 0xff) + 0.7152 * ((n >> 8) & 0xff) + 0.0722 * (n & 0xff)) / 255;
}

/** Layout of the video card: fitted inside padding, centered, chrome-aware. */
export function frameLayout(project: Project, srcW: number, srcH: number): FrameLayout {
  const { width: W, height: H, padding, chrome } = project.canvas;
  const pad = padding * Math.min(W, H);
  const availW = W - pad * 2;
  const availH = H - pad * 2;
  const barH = titleBarHeight(chrome, W, H);
  const bz = bezelWidth(chrome, W, H);

  const scale = Math.min((availW - bz * 2) / srcW, (availH - barH - bz * 2) / srcH);
  const vw = srcW * scale;
  const vh = srcH * scale;
  const fw = vw + bz * 2;
  const fh = vh + barH + bz * 2;
  const fx = (W - fw) / 2;
  const fy = (H - fh) / 2;
  return {
    frameRect: { x: fx, y: fy, w: fw, h: fh },
    videoRect: { x: fx + bz, y: fy + barH + bz, w: vw, h: vh },
  };
}

function paintChromeBar(ctx: Ctx2D, chrome: FrameChrome, frameRect: Rect, s: number): void {
  if (chrome.style !== 'mac' && chrome.style !== 'browser') return;
  const barH = Math.round(36 * s);
  ctx.fillStyle = '#2a2f3a';
  ctx.fillRect(frameRect.x, frameRect.y, frameRect.w, barH);

  const lights = ['#ff5f57', '#febc2e', '#28c840'];
  lights.forEach((color, i) => {
    ctx.beginPath();
    ctx.arc(frameRect.x + (20 + i * 20) * s, frameRect.y + barH / 2, 6 * s, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  });

  if (chrome.style === 'browser' && chrome.urlText) {
    const pillX = frameRect.x + 90 * s;
    const pillW = frameRect.w - (90 + 24) * s;
    const pillH = 22 * s;
    const pillY = frameRect.y + (barH - pillH) / 2;
    if (pillW > 40 * s) {
      ctx.save();
      roundedRectPath(ctx, pillX, pillY, pillW, pillH, pillH / 2);
      ctx.fillStyle = '#1a1e27';
      ctx.fill();
      ctx.clip();
      ctx.fillStyle = '#8b93a3';
      ctx.font = `${Math.round(12 * s)}px -apple-system, 'Segoe UI', Roboto, sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.fillText(chrome.urlText, pillX + 12 * s, pillY + pillH / 2 + 1 * s);
      ctx.restore();
    }
  }
}

function paintPhoneNotch(ctx: Ctx2D, chrome: FrameChrome, videoRect: Rect, s: number): void {
  if (chrome.style !== 'phone') return;
  const w = Math.min(videoRect.w * 0.32, 220 * s);
  const h = 22 * s;
  roundedRectPath(ctx, videoRect.x + (videoRect.w - w) / 2, videoRect.y + 8 * s, w, h, h / 2);
  ctx.fillStyle = '#0b0d12';
  ctx.fill();
}

/** Edge darkening while zoomed; fades in/out with the ramps via pose.zoom. */
function paintVignette(ctx: Ctx2D, strength: number, zoom: number, videoRect: Rect): void {
  const alpha = strength * clamp((zoom - 1) / 0.5, 0, 1);
  if (alpha <= 0) return;
  const cx = videoRect.x + videoRect.w / 2;
  const cy = videoRect.y + videoRect.h / 2;
  const rOuter = Math.hypot(videoRect.w, videoRect.h) / 2;
  const grad = ctx.createRadialGradient(cx, cy, rOuter * 0.55, cx, cy, rOuter);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, `rgba(0,0,0,${alpha})`);
  ctx.fillStyle = grad;
  ctx.fillRect(videoRect.x, videoRect.y, videoRect.w, videoRect.h);
}

function paintBackground(ctx: Ctx2D, bg: Background, W: number, H: number, frame: FrameSource | null): void {
  if (bg.type === 'frame-blur') {
    if (frame) return paintFrameBlur(ctx, bg.blurPx, bg.brightness, W, H, frame);
  } else if (bg.type === 'image') {
    const img = backgroundImages.get(bg.imageId);
    if (img) return void drawCover(ctx, img, img.width, img.height, 0, 0, W, H, 0);
  } else if (bg.type === 'solid') {
    ctx.fillStyle = bg.color;
    ctx.fillRect(0, 0, W, H);
    return;
  } else {
    const rad = ((bg.angle - 90) * Math.PI) / 180;
    const half = (Math.abs(W * Math.cos(rad)) + Math.abs(H * Math.sin(rad))) / 2;
    const cx = W / 2;
    const cy = H / 2;
    const grad = ctx.createLinearGradient(
      cx - Math.cos(rad) * half,
      cy - Math.sin(rad) * half,
      cx + Math.cos(rad) * half,
      cy + Math.sin(rad) * half,
    );
    grad.addColorStop(0, bg.from);
    grad.addColorStop(1, bg.to);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    return;
  }
  // frame-blur before any frame exists / image not (yet) in the registry.
  ctx.fillStyle = '#1e2430';
  ctx.fillRect(0, 0, W, H);
}

/**
 * Blur at 1/4 scale on a scratch canvas (≈16× cheaper than blurring at full
 * resolution, visually identical after upscale), overscanning the cover-fit
 * by the blur radius so edges don't pull in transparency.
 */
const BLUR_DOWNSCALE = 4;
let blurScratch: OffscreenCanvas | null = null;

function paintFrameBlur(
  ctx: Ctx2D,
  blurPx: number,
  brightness: number,
  W: number,
  H: number,
  frame: FrameSource,
): void {
  const sw = Math.max(1, Math.round(W / BLUR_DOWNSCALE));
  const sh = Math.max(1, Math.round(H / BLUR_DOWNSCALE));
  if (!blurScratch || blurScratch.width !== sw || blurScratch.height !== sh) {
    blurScratch = new OffscreenCanvas(sw, sh);
  }
  const sctx = blurScratch.getContext('2d');
  if (!sctx) return;
  const r = Math.max(1, Math.round(blurPx / BLUR_DOWNSCALE));
  sctx.filter = `blur(${r}px)`;
  drawCover(sctx, frame.image, frame.width, frame.height, 0, 0, sw, sh, r);
  sctx.filter = 'none';
  ctx.drawImage(blurScratch, 0, 0, sw, sh, 0, 0, W, H);

  const dim = 1 - clamp(brightness, 0, 1);
  if (dim > 0) {
    ctx.fillStyle = `rgba(0,0,0,${dim})`;
    ctx.fillRect(0, 0, W, H);
  }
}

/** drawImage scaled to cover [x,y,w,h], centered, expanded by `overscan` px per side. */
function drawCover(
  ctx: Ctx2D,
  image: CanvasImageSource,
  imgW: number,
  imgH: number,
  x: number,
  y: number,
  w: number,
  h: number,
  overscan: number,
): void {
  const tw = w + overscan * 2;
  const th = h + overscan * 2;
  const scale = Math.max(tw / imgW, th / imgH);
  const dw = imgW * scale;
  const dh = imgH * scale;
  ctx.drawImage(image, x - overscan + (tw - dw) / 2, y - overscan + (th - dh) / 2, dw, dh);
}

function roundedRectPath(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}
