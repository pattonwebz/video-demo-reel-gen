import { useState } from 'react';
import { ASPECT_PRESETS, BACKGROUND_PRESETS } from '../engine/types';
import { useEditor } from '../state/store';

export default function SettingsPanel() {
  const [collapsed, setCollapsed] = useState(false);
  const canvas = useEditor((s) => s.project.canvas);
  const { setCanvasSize, setBackground, setPadding, setCornerRadius, setShadowOpacity } =
    useEditor.getState();

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
                      : `linear-gradient(${p.bg.angle}deg, ${p.bg.from}, ${p.bg.to})`,
                }}
                onClick={() => setBackground(p.bg)}
              />
            ))}
          </div>
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
        </section>
      </div>
    </aside>
  );
}
