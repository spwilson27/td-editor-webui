import { useRef, useState } from 'preact/hooks';
import { hslToRgb } from '../state/colour';
import { capture } from './capture';
import { store } from '../state/store';
import { Icon } from './Icon';

const SIZE = 180, C = SIZE / 2, RING_MID = 81, RING_IN = 72, SQ = 44, SQ_SIZE = 92;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function Wheel() {
  const ref = useRef<HTMLDivElement>(null);
  const mode = useRef<'ring' | 'sv' | null>(null);
  const { h, s, v } = store.hsv.value;
  const rad = (h * Math.PI) / 180;

  const apply = (e: PointerEvent, start: boolean) => {
    const r = ref.current!.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (start) {
      const dist = Math.hypot(x - C, y - C);
      mode.current = dist >= RING_IN && dist <= C ? 'ring' : x >= SQ && x <= SQ + SQ_SIZE && y >= SQ && y <= SQ + SQ_SIZE ? 'sv' : null;
      if (mode.current) capture(ref.current!, e.pointerId);
    }
    if (mode.current === 'ring') {
      const deg = (Math.atan2(x - C, C - y) * 180) / Math.PI;
      store.setHsv({ ...store.hsv.peek(), h: (deg + 360) % 360 });
    } else if (mode.current === 'sv') {
      store.setHsv({ ...store.hsv.peek(), s: clamp01((x - SQ) / SQ_SIZE), v: 1 - clamp01((y - SQ) / SQ_SIZE) });
    }
  };
  const end = () => { if (mode.current) store.pushRecent(store.primary.peek()); mode.current = null; };

  return (
    <div ref={ref} data-wheel style={`position:relative;width:${SIZE}px;height:${SIZE}px;align-self:center;touch-action:none;cursor:crosshair`}
      onPointerDown={(e) => apply(e, true)} onPointerMove={(e) => mode.current && apply(e, false)}
      onPointerUp={end} onPointerCancel={end}>
      <div style="position:absolute;inset:0;border-radius:50%;background:conic-gradient(from 0deg,#ff0000,#ffff00,#00ff00,#00ffff,#0000ff,#ff00ff,#ff0000)" />
      <div style="position:absolute;inset:18px;border-radius:50%;background:#2b2b2b" />
      <div style={`position:absolute;left:${SQ}px;top:${SQ}px;width:${SQ_SIZE}px;height:${SQ_SIZE}px;border-radius:3px;background-color:hsl(${Math.round(h)},100%,50%);background-image:linear-gradient(to top,#000000,rgba(0,0,0,0)),linear-gradient(to right,#ffffff,rgba(255,255,255,0))`} />
      <div data-handle="ring" style={`position:absolute;left:${C + RING_MID * Math.sin(rad)}px;top:${C - RING_MID * Math.cos(rad)}px;width:14px;height:14px;transform:translate(-50%,-50%);border-radius:50%;border:2px solid #ffffff;box-shadow:0 0 0 1px #000000;pointer-events:none`} />
      <div data-handle="sv" style={`position:absolute;left:${SQ + s * SQ_SIZE}px;top:${SQ + (1 - v) * SQ_SIZE}px;width:10px;height:10px;transform:translate(-50%,-50%);border-radius:50%;border:2px solid #ffffff;box-shadow:0 0 0 1px #000000;pointer-events:none`} />
    </div>
  );
}

interface SliderProps { k: string; value: string; pos: number; track: string; onChange: (frac: number) => void; onEnd?: () => void }

function Slider({ k, value, pos, track, onChange, onEnd }: SliderProps) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef(false);
  const move = (e: PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    onChange(clamp01((e.clientX - r.left) / r.width));
  };
  return (
    <div style="display:grid;grid-template-columns:14px minmax(0,1fr) 44px;align-items:center;gap:8px">
      <span style="color:#a8a8a8;font-weight:600">{k}</span>
      <div ref={ref} data-slider={k} style="position:relative;height:10px;border-radius:5px;background-color:#ffffff;background-image:repeating-conic-gradient(#bdbdbd 0 25%,#ffffff 0 50%);background-size:8px 8px;touch-action:none;cursor:pointer"
        onPointerDown={(e) => { drag.current = true; capture(ref.current!, e.pointerId); move(e); }}
        onPointerMove={(e) => drag.current && move(e)}
        onPointerUp={() => { drag.current = false; onEnd?.(); }} onPointerCancel={() => { drag.current = false; }}>
        <div style={`position:absolute;inset:0;border-radius:5px;background:${track}`} />
        <div style={`position:absolute;top:50%;left:${pos * 100}%;width:12px;height:12px;transform:translate(-50%,-50%);border-radius:50%;background:#ffffff;box-shadow:0 0 0 1px #000000,0 1px 3px rgba(0,0,0,0.5);pointer-events:none`} />
      </div>
      <span style="padding:2px 4px;text-align:right;background:#1f1f1f;border:1px solid #474747;border-radius:4px">{value}</span>
    </div>
  );
}

function Sliders() {
  const hsl = store.hsl.value;
  const hue = Math.round(hsl.h), L = Math.round(hsl.l * 100);
  const a = store.alpha.value;
  const fromHsl = (p: Partial<typeof hsl>) => store.applyRgb(hslToRgb({ ...hsl, ...p }));
  const done = () => store.pushRecent(store.primary.peek());
  return (
    <div style="display:flex;flex-direction:column;gap:8px">
      <Slider k="H" value={`${hue}°`} pos={hsl.h / 360} onEnd={done}
        track="linear-gradient(to right,#ff0000,#ffff00,#00ff00,#00ffff,#0000ff,#ff00ff,#ff0000)"
        onChange={(f) => store.setHsv({ ...store.hsv.peek(), h: Math.min(359.99, f * 360) })} />
      <Slider k="S" value={`${Math.round(hsl.s * 100)}%`} pos={hsl.s} onEnd={done}
        track={`linear-gradient(to right,hsl(${hue},0%,${L}%),hsl(${hue},100%,${L}%))`} onChange={(f) => fromHsl({ s: f })} />
      <Slider k="L" value={`${L}%`} pos={hsl.l} onEnd={done}
        track={`linear-gradient(to right,#000000,hsl(${hue},${Math.round(hsl.s * 100)}%,50%),#ffffff)`} onChange={(f) => fromHsl({ l: f })} />
      <Slider k="A" value={`${a}%`} pos={a / 100} onEnd={done}
        track={`linear-gradient(to right,rgba(0,0,0,0),${store.primary.value})`} onChange={(f) => { store.alpha.value = Math.round(f * 100); }} />
    </div>
  );
}

function HexField() {
  const ref = useRef<HTMLInputElement>(null);
  const dirty = useRef(false);
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (dirty.current) store.setPrimaryHex(ref.current!.value);
    dirty.current = false;
    ref.current!.value = store.primary.peek().toUpperCase();
    setDraft(null);
  };
  return (
    <>
      <label for="hex" style="color:#a8a8a8">Hex</label>
      <input ref={ref} id="hex" value={draft ?? store.primary.value.toUpperCase()} spellcheck={false} maxLength={7}
        onInput={(e) => { dirty.current = true; setDraft((e.target as HTMLInputElement).value); }} onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { commit(); ref.current!.blur(); } else if (e.key === 'Escape') { dirty.current = false; setDraft(null); } }}
        style="width:74px;height:24px;box-sizing:border-box;padding:0 6px;font-family:ui-monospace,Menlo,monospace;color:#e3e3e3;background:#1f1f1f;border:1px solid #474747;border-radius:4px" />
    </>
  );
}

export function ColourPanel() {
  return (
    <div style="display:flex;flex-direction:column;gap:12px;padding:12px">
      <div style="display:flex;align-items:center;gap:12px">
        <div style="position:relative;width:44px;height:40px;flex:none">
          <button aria-label="Secondary colour" data-swatch="secondary" onClick={() => store.swapColours()}
            style={`position:absolute;right:0;bottom:0;width:26px;height:26px;border-radius:50%;border:2px solid #1a1a1a;box-shadow:0 0 0 1px #5a5a5a;background:${store.secondary.value}`} />
          <button aria-label="Primary colour" data-swatch="primary"
            style={`position:absolute;left:0;top:0;width:30px;height:30px;border-radius:50%;border:2px solid #1a1a1a;box-shadow:0 0 0 1px #8a8a8a;background:${store.primary.value}`} />
        </div>
        <button class="ib" aria-label="Swap primary and secondary" title="Swap (X)" onClick={() => store.swapColours()} style="width:28px;height:28px">
          <Icon d="M7 4L3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7" />
        </button>
        <div style="flex:1 1 auto" />
        <HexField />
      </div>
      <Wheel />
      <Sliders />
      <div style="display:flex;flex-direction:column;gap:6px">
        <span style="color:#a8a8a8">Recent</span>
        <div style="display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:4px">
          {store.recent.value.map((h) => (
            <button key={h} class="sw" data-recent={h} aria-label={`Use ${h}`} title={h} onClick={() => store.setPrimaryHex(h)}
              style={`aspect-ratio:1;border-radius:3px;box-shadow:inset 0 0 0 1px rgba(255,255,255,0.12);background:${h}`} />
          ))}
        </div>
      </div>
    </div>
  );
}

