import { useState, type ChangeEvent } from 'react';
import { ASPECT_PRESETS, BACKGROUND_PRESETS } from '../engine/types';
import type { ChromeStyle } from '../engine/types';
import { backgroundImages } from '../engine/assets';
import { useEditor, newId } from '../state/store';

const CHROME_OPTIONS: { value: ChromeStyle; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'mac', label: 'macOS' },
  { value: 'browser', label: 'Browser' },
  { value: 'phone', label: 'Phone' },
];

export default function SettingsPanel() {
  const [collapsed, setCollapsed] = useState(false);
  const canvas = useEditor((s) => s.project.canvas);
  const {
    setCanvasSize,
    setBackground,
    setPadding,
    setCornerRadius,
    setShadowOpacity,
    setChrome,
    setZoomVignette,
    setDefaultDriftPct,
  } = useEditor.getState();

  const bg = canvas.background;

  async function handleImageFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const bitmap = await createImageBitmap(file);
    const id = newId('bgimg');
    backgroundImages.set(id, bitmap);
    setBackground({ type: 'image', imageId: id });
  }

  return (
    <aside className={`settings-panel${collapsed ? ' collapsed' : ''}`}>
      <div className="settings-panel-header">
        <h2>Settings</h2>
        <button
          type="button"
          className="btn settings-toggle"
          onClick={() => setCollapsed((v) => !v)}
          aria-expanded={!collapsed}
        >
          {collapsed ? 'Show' : 'Hide'}
        </button>
      </div>

      <div className="settings-panel-body">
        <section>
          <h2>Canvas</h2>
          <div className="chip-row">
            {ASPECT_PRESETS.map((p) => (
              <button
                key={p.name}
                className={`chip${canvas.width === p.width && canvas.height === p.height ? ' active' : ''}`}
                onClick={() => setCanvasSize(p.width, p.height)}
              >
                {p.name}
              </button>
            ))}
          </div>
        </section>

        <section>
          <h2>Background</h2>
          <div className="swatch-row">
            {BACKGROUND_PRESETS.map((p) => (
              <button
                key={p.name}
                title={p.name}
                className={`swatch${JSON.stringify(canvas.background) === JSON.stringify(p.bg) ? ' active' : ''}`}
                style={{
                  background:
                    p.bg.type === 'solid'
                      ? p.bg.color
                      : p.bg.type === 'gradient'
                        ? `linear-gradient(${p.bg.angle}deg, ${p.bg.from}, ${p.bg.to})`
                        : undefined,
                }}
                onClick={() => setBackground(p.bg)}
              />
            ))}
            <button
              type="button"
              title="Frame blur background"
              className={`swatch swatch-blur${bg.type === 'frame-blur' ? ' active' : ''}`}
              onClick={() => setBackground({ type: 'frame-blur', blurPx: 60, brightness: 0.7 })}
            />
            <label
              title="Image background"
              className={`swatch swatch-img${bg.type === 'image' ? ' active' : ''}`}
            >
              Img
              <input
                type="file"
                accept="image/*"
                className="file-input-hidden"
                onChange={(e) => {
                  void handleImageFile(e);
                }}
              />
            </label>
          </div>
          {bg.type === 'frame-blur' && (
            <>
              <label className="slider-label">
                Blur
                <input
                  type="range"
                  min={20}
                  max={120}
                  step={5}
                  value={bg.blurPx}
                  onChange={(e) => setBackground({ ...bg, blurPx: Number(e.target.value) })}
                />
              </label>
              <label className="slider-label">
                Brightness
                <input
                  type="range"
                  min={40}
                  max={100}
                  step={5}
                  value={Math.round(bg.brightness * 100)}
                  onChange={(e) => setBackground({ ...bg, brightness: Number(e.target.value) / 100 })}
                />
              </label>
            </>
          )}
        </section>

        <section>
          <h2>Chrome</h2>
          <div className="chip-row">
            {CHROME_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={`chip${canvas.chrome.style === opt.value ? ' active' : ''}`}
                onClick={() => setChrome({ ...canvas.chrome, style: opt.value })}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {canvas.chrome.style === 'browser' && (
            <input
              type="text"
              className="text-input"
              placeholder="example.com"
              value={canvas.chrome.urlText ?? ''}
              onChange={(e) => setChrome({ ...canvas.chrome, urlText: e.target.value })}
            />
          )}
        </section>

        <section>
          <h2>Frame</h2>
          <label className="slider-label">
            Padding
            <input
              type="range"
              min={0}
              max={0.25}
              step={0.005}
              value={canvas.padding}
              onChange={(e) => setPadding(Number(e.target.value))}
            />
          </label>
          <label className="slider-label">
            Corner radius
            <input
              type="range"
              min={0}
              max={64}
              step={1}
              value={canvas.cornerRadius}
              onChange={(e) => setCornerRadius(Number(e.target.value))}
            />
          </label>
          <label className="slider-label">
            Shadow
            <input
              type="range"
              min={0}
              max={0.8}
              step={0.05}
              value={canvas.shadow.opacity}
              onChange={(e) => setShadowOpacity(Number(e.target.value))}
            />
          </label>
          <label className="slider-label">
            Zoom vignette
            <input
              type="range"
              min={0}
              max={40}
              step={5}
              value={Math.round(canvas.zoomVignette * 100)}
              onChange={(e) => setZoomVignette(Number(e.target.value) / 100)}
            />
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={canvas.defaultDriftPct > 0}
              onChange={(e) => setDefaultDriftPct(e.target.checked ? 0.03 : 0)}
            />
            Drift during holds <span className="hint">(new zooms)</span>
          </label>
        </section>
      </div>
    </aside>
  );
}
