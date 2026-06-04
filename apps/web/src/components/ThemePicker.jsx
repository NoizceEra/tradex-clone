import { useState } from 'react';
import { useTheme, SKINS } from '../store/theme';

/**
 * Global skin picker: a chip in the navbar that opens a drawer of skin cards.
 * Cosmetic only — reskins the whole site via <html data-theme>; independent of
 * which market/game you're trading.
 */
export function ThemePicker() {
  const [open, setOpen] = useState(false);
  const skin = useTheme((s) => s.skin);
  const setSkin = useTheme((s) => s.setSkin);
  const active = SKINS.find((s) => s.id === skin) || SKINS[0];

  return (
    <>
      <button className="theme-trigger" onClick={() => setOpen((o) => !o)} title={`Skin: ${active.label}`} aria-label="Change skin">
        <span className="theme-sw" style={{ background: active.sw }} />
        {active.label.split(' - ').pop()} ▾
      </button>

      {open && (
        <>
          <div className="theme-scrim" onClick={() => setOpen(false)} />
          <div className="theme-drawer" role="dialog" aria-label="Choose your skin">
            <div className="theme-drawer-head">
              <span>Choose your skin</span>
              <button onClick={() => setOpen(false)} aria-label="Close">✕</button>
            </div>
            <div className="theme-cards">
              {SKINS.map((s) => (
                <button
                  key={s.id}
                  className={`theme-card ${s.id === skin ? 'on' : ''}`}
                  onClick={() => { setSkin(s.id); setOpen(false); }}
                >
                  <span className="theme-card-sw" style={{ background: s.sw }} />
                  <span className="theme-card-label">{s.label}</span>
                  {s.id === skin && <span className="theme-card-check">✓</span>}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </>
  );
}
