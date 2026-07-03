import type { Background, Project } from './types';
import { cameraAt, poseToSourceCrop } from './camera';

export interface FrameSource {
  image: CanvasImageSource;
  width: number;
  height: number;
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/**
 * Render one output frame. Pure with respect to inputs: the same
 * (project, timeMs, frame) always paints the same pixels, so preview and
 * export share this path.
 */
export function renderFrame(ctx: Ctx2D, project: Project, timeMs: number, frame: FrameSource | null): void {
  const { width: W, height: H } = project.canvas;
  paintBackground(ctx, project.canvas.background, W, H);
  if (!frame) return;

  const rect = contentRect(project, frame.width, frame.height);
  const { cornerRadius, shadow } = project.canvas;
  const radius = Math.min(cornerRadius, rect.w / 2, rect.h / 2);

  ctx.save();
  ctx.shadowColor = `rgba(0,0,0,${shadow.opacity})`;
  ctx.shadowBlur = shadow.blur;
  ctx.shadowOffsetY = shadow.offsetY;
  roundedRectPath(ctx, rect.x, rect.y, rect.w, rect.h, radius);
  ctx.fillStyle = '#000';
  ctx.fill();
  ctx.restore();

  const pose = cameraAt(project.zooms, timeMs);
  const crop = poseToSourceCrop(pose, frame.width, frame.height);

  ctx.save();
  roundedRectPath(ctx, rect.x, rect.y, rect.w, rect.h, radius);
  ctx.clip();
  ctx.drawImage(frame.image, crop.sx, crop.sy, crop.sw, crop.sh, rect.x, rect.y, rect.w, rect.h);
  ctx.restore();
}

/** Where the video frame sits on the canvas: fitted inside padding, centered. */
export function contentRect(
  project: Project,
  srcW: number,
  srcH: number,
): { x: number; y: number; w: number; h: number } {
  const { width: W, height: H, padding } = project.canvas;
  const pad = padding * Math.min(W, H);
  const availW = W - pad * 2;
  const availH = H - pad * 2;
  const scale = Math.min(availW / srcW, availH / srcH);
  const w = srcW * scale;
  const h = srcH * scale;
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}

function paintBackground(ctx: Ctx2D, bg: Background, W: number, H: number): void {
  if (bg.type === 'solid') {
    ctx.fillStyle = bg.color;
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
  }
  ctx.fillRect(0, 0, W, H);
}

function roundedRectPath(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}
