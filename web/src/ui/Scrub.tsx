// v7.2 (DESIGN_V7 section 7): scrubbable option dropdowns and number boxes.
//
// ScrubSelect is a native <select> (a11y, keyboard, form semantics, every call site's value / onChange stay as they were) whose
// mouse press is intercepted: press + drag >= 4 px steps through the options live (down / right = next, up / left = previous,
// one option per 12 px along the dominant axis, disabled options skipped), a press-release without that movement opens the list.
// A native <select> opens its popup on mousedown, so the press is taken over (pointerdown + mousedown preventDefault, pointer
// capture) and the list is opened on release: select.showPicker() (Chromium >= 121; TouchDesigner's Web Render TOP is CEF 132 and
// paints the popup) or, where that is missing or refused, a small custom listbox below the box (keyboard + mouse).
//
// ScrubNumber is a number box whose press-drag changes the value (up = larger, 0.5 per px; Shift x10, Alt x0.1), clamped, rAF
// throttled and applied live; typing applies valid values live; Escape reverts. A drag is one history step (store.beginGesture).
import type { JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { store } from '../state/store';

/** Pixels of movement before a press becomes a scrub (below that it is a click). */
export const SCRUB_START_PX = 4;
/** Pixels per option step while scrubbing a dropdown. */
export const SCRUB_STEP_PX = 12;

/**
 * Option index after moving `delta` px (positive = next) from `start`: one step per `px`, truncated toward zero, clamped at the
 * ends, disabled options skipped (they cost no distance).
 */
export function scrubSteps(disabled: readonly boolean[], start: number, steps: number): { idx: number; taken: number } {
  if (!steps) return { idx: start, taken: 0 };
  const dir = steps > 0 ? 1 : -1;
  let i = start, taken = 0;
  for (let n = Math.abs(steps); n > 0; n--) {
    let j = i + dir;
    while (j >= 0 && j < disabled.length && disabled[j]) j += dir;
    if (j < 0 || j >= disabled.length) break;
    i = j;
    taken += dir;
  }
  return { idx: i, taken };
}

export function scrubIndex(disabled: readonly boolean[], start: number, delta: number, px = SCRUB_STEP_PX): number {
  return scrubSteps(disabled, start, Math.trunc(delta / px)).idx;
}

/** Value after a drag of `dyPx` (up = positive) from `acc`, clamped; `perPx` units per px, modifiers scale it. */
export function scrubValue(acc: number, dyPx: number, perPx: number, mods: { shift?: boolean; alt?: boolean }, min: number, max: number): number {
  const mult = mods.shift ? 10 : mods.alt ? 0.1 : 1;
  return Math.min(max, Math.max(min, acc + dyPx * perPx * mult));
}

const decimals = (step: number) => { const s = String(step); const i = s.indexOf('.'); return i < 0 ? 0 : s.length - i - 1; };
const snap = (v: number, step: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, +(Math.round(v / step) * step).toFixed(decimals(step))));

// ---- shared overlay bits (plain DOM: they must not depend on the host panel's layout / overflow) ----

const TIP_CSS = 'position:fixed;z-index:100001;pointer-events:none;padding:2px 8px;font:11px sans-serif;color:#e3e3e3;background:#111;'
  + 'border:1px solid #474747;border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,0.5);white-space:nowrap;max-width:260px;overflow:hidden;text-overflow:ellipsis';
let tip: HTMLElement | null = null;

function showTip(text: string, anchor: Element) {
  if (!tip) {
    tip = document.createElement('div');
    tip.setAttribute('data-scrub-tip', '');
    tip.setAttribute('aria-hidden', 'true');
    tip.style.cssText = TIP_CSS;
  }
  if (!tip.isConnected) document.body.appendChild(tip);
  tip.textContent = text;
  const r = anchor.getBoundingClientRect();
  const w = tip.offsetWidth, h = tip.offsetHeight;
  const above = r.top - h - 6 >= 0;
  tip.style.left = `${Math.max(4, Math.min(window.innerWidth - w - 4, r.left + r.width / 2 - w / 2))}px`;
  tip.style.top = `${above ? r.top - h - 6 : r.bottom + 6}px`;
}

function hideTip() {
  tip?.remove();
}

interface ListState { sel: HTMLSelectElement; close: () => void }
let list: ListState | null = null;

function closeList() {
  list?.close();
  list = null;
}

const fire = (sel: HTMLSelectElement) => {
  sel.dispatchEvent(new Event('input', { bubbles: true }));
  sel.dispatchEvent(new Event('change', { bubbles: true }));
};

/** The fallback popup: a listbox under (or over) the box. Mouse: hover / click; keys: arrows, Home / End, Enter / Space, Escape. */
function openList(sel: HTMLSelectElement) {
  closeList();
  const opts = [...sel.options];
  if (!opts.length) return;
  const isOff = (o: HTMLOptionElement) => o.disabled || (o.parentElement instanceof HTMLOptGroupElement && o.parentElement.disabled);
  const el = document.createElement('div');
  el.setAttribute('role', 'listbox');
  el.setAttribute('data-scrub-list', '');
  const label = sel.getAttribute('aria-label');
  if (label) el.setAttribute('aria-label', label);
  el.style.cssText = 'position:fixed;z-index:100000;box-sizing:border-box;overflow-y:auto;padding:3px 0;font:12px sans-serif;color:#e3e3e3;background:#1f1f1f;'
    + 'border:1px solid #474747;border-radius:4px;box-shadow:0 6px 18px rgba(0,0,0,0.55);user-select:none';
  const rows: HTMLElement[] = [];
  let active = Math.max(0, sel.selectedIndex);
  const paint = () => rows.forEach((r, i) => {
    const on = i === active, off = isOff(opts[i]);
    r.style.background = on && !off ? '#4a8fe0' : 'transparent';
    r.style.color = off ? '#6f6f6f' : on ? '#fff' : '#e3e3e3';
    r.setAttribute('aria-selected', String(i === sel.selectedIndex));
  });
  const pick = (i: number) => {
    if (isOff(opts[i])) return;
    const changed = i !== sel.selectedIndex;
    sel.selectedIndex = i;
    closeList();
    if (changed) fire(sel);
  };
  let group: Node | null = null;
  opts.forEach((o, i) => {
    const g = o.parentElement instanceof HTMLOptGroupElement ? o.parentElement : null;
    if (g !== group) {
      group = g;
      if (g) {
        const h = document.createElement('div');
        h.textContent = g.label;
        h.style.cssText = 'padding:3px 10px 2px;color:#8a8a8a;font-size:11px';
        el.appendChild(h);
      }
    }
    const row = document.createElement('div');
    row.setAttribute('role', 'option');
    row.setAttribute('data-scrub-option', String(i));
    row.textContent = o.text;
    row.style.cssText = `padding:3px 10px 3px ${g ? 18 : 10}px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:default`;
    row.addEventListener('pointerenter', () => { if (!isOff(o)) { active = i; paint(); } });
    row.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); pick(i); });
    rows.push(row);
    el.appendChild(row);
  });
  paint();
  document.body.appendChild(el);

  const r = sel.getBoundingClientRect();
  const room = { below: window.innerHeight - r.bottom - 8, above: r.top - 8 };
  const natural = el.scrollHeight + 2;
  const down = room.below >= Math.min(natural, 200) || room.below >= room.above;
  const maxH = Math.max(60, Math.min(320, down ? room.below : room.above));
  const h = Math.min(natural, maxH);
  el.style.maxHeight = `${maxH}px`;
  el.style.minWidth = `${Math.round(r.width)}px`;
  el.style.left = `${Math.max(4, Math.min(window.innerWidth - el.offsetWidth - 4, r.left))}px`;
  el.style.top = `${down ? r.bottom + 2 : r.top - h - 2}px`;
  rows[active]?.scrollIntoView({ block: 'nearest' });

  const move = (dir: number, from = active) => {
    let j = from + dir;
    while (j >= 0 && j < opts.length && isOff(opts[j])) j += dir;
    if (j >= 0 && j < opts.length) { active = j; paint(); rows[j].scrollIntoView({ block: 'nearest' }); }
  };
  const onKey = (e: KeyboardEvent) => {
    const k = e.key;
    if (k === 'Escape' || k === 'Tab') { if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); } closeList(); return; }
    const handled = k === 'ArrowDown' || k === 'ArrowUp' || k === 'Home' || k === 'End' || k === 'Enter' || k === ' ';
    if (!handled) return;
    e.preventDefault();
    e.stopPropagation();
    if (k === 'ArrowDown') move(1);
    else if (k === 'ArrowUp') move(-1);
    else if (k === 'Home') move(1, -1);
    else if (k === 'End') move(-1, opts.length);
    else pick(active);
  };
  const onOutside = (e: Event) => { if (e.target !== sel && !el.contains(e.target as Node)) closeList(); };
  const onScroll = (e: Event) => { if (!el.contains(e.target as Node)) closeList(); };
  window.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onOutside, true);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', closeList);
  window.addEventListener('blur', closeList);
  sel.addEventListener('blur', closeList);
  sel.setAttribute('aria-expanded', 'true');
  sel.setAttribute('data-scrub-opened', 'list');
  list = {
    sel,
    close: () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onOutside, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', closeList);
      window.removeEventListener('blur', closeList);
      sel.removeEventListener('blur', closeList);
      sel.removeAttribute('aria-expanded');
      el.remove();
    },
  };
}

/** Open the option list: the browser's own picker where it is allowed, else the fallback listbox. */
function openOptions(sel: HTMLSelectElement) {
  try { sel.focus({ preventScroll: true }); } catch { /* detached */ }
  const picker = (sel as HTMLSelectElement & { showPicker?: () => void }).showPicker;
  if (typeof picker === 'function') {
    try {
      picker.call(sel);
      sel.setAttribute('data-scrub-opened', 'native');
      return;
    } catch { /* NotAllowedError without user activation, or an engine that cannot show it: use the listbox */ }
  }
  openList(sel);
}

// ---- ScrubSelect ----

/** The press being dragged (a ScrubSelect or a ScrubNumber): a second press, an unmount or a lost button ends it (committing). */
let activePress: { owner: Element; stop: (cancel: boolean) => void } | null = null;

function pressSelect(e: PointerEvent, sel: HTMLSelectElement, model: () => string | undefined) {
  if (e.button !== 0 || e.pointerType === 'touch' || sel.disabled || !sel.options.length) return; // touch keeps the native popup
  e.preventDefault(); // no native popup on press, no text selection while dragging
  activePress?.stop(false);
  const wasOpen = list?.sel === sel;
  if (wasOpen) closeList();
  try { sel.focus({ preventScroll: true }); } catch { /* ignore */ }
  const startValue = sel.value;
  const x0 = e.clientX, y0 = e.clientY, id = e.pointerId;
  const cursor0 = sel.style.cursor;
  let axis: 'x' | 'y' | null = null;
  let cur = startValue; // the value applied last: steps run from it, so a list that changes while dragging (zoom, sources) cannot shift them
  let done = 0; // net steps applied
  let ended = false;
  try { sel.setPointerCapture(id); } catch { /* synthetic pointer */ }

  const setByValue = (v: string, notify: boolean) => {
    const i = [...sel.options].findIndex((o) => o.value === v);
    if (i < 0) return;
    sel.selectedIndex = i;
    if (notify) fire(sel);
  };
  const stop = (cancel: boolean) => {
    if (ended) return;
    ended = true;
    activePress = null;
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', up, true);
    window.removeEventListener('pointercancel', lost, true);
    window.removeEventListener('keydown', key, true);
    window.removeEventListener('blur', lost);
    sel.removeEventListener('lostpointercapture', lost);
    try { sel.releasePointerCapture(id); } catch { /* not captured */ }
    sel.style.cursor = cursor0;
    hideTip();
    if (!axis) return;
    const undo = cancel || cur === startValue; // Escape, or back at the start value = nothing to keep
    const r = store.endGesture(undo);
    if (!undo) return;
    if (r === 'kept') { const m = model(); if (m !== undefined) setByValue(m, false); } // the model moved on (external undo / edit): show it, push nothing
    else if (cur !== startValue) setByValue(startValue, true);
  };
  function move(ev: PointerEvent) {
    if (ev.pointerId !== id) return;
    if (ev.buttons === 0) { stop(false); return; } // the button went up unseen (outside the window, a lost capture): end the drag
    const dx = ev.clientX - x0, dy = ev.clientY - y0;
    if (!axis) {
      if (Math.hypot(dx, dy) < SCRUB_START_PX) return;
      axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      store.beginGesture();
      sel.style.cursor = axis === 'x' ? 'ew-resize' : 'ns-resize';
    }
    const target = Math.trunc((axis === 'x' ? dx : dy) / SCRUB_STEP_PX);
    const opts = [...sel.options];
    if (target !== done) {
      let from = opts.findIndex((o) => o.value === cur);
      if (from < 0) from = sel.selectedIndex;
      const r = scrubSteps(opts.map((o) => o.disabled || (o.parentElement instanceof HTMLOptGroupElement && o.parentElement.disabled)), from, target - done);
      done += r.taken;
      if (r.idx !== from) { cur = opts[r.idx].value; sel.selectedIndex = r.idx; fire(sel); }
    }
    const shown = [...sel.options].find((o) => o.value === cur);
    showTip(shown?.text ?? '', sel);
  }
  function up(ev: PointerEvent) {
    if (ev.pointerId !== id) return;
    const scrubbed = !!axis;
    stop(false);
    if (!scrubbed && !wasOpen) openOptions(sel);
  }
  function lost() { stop(false); } // pointer cancelled / capture lost / window blurred: keep what the drag did
  function key(ev: KeyboardEvent) {
    if (ev.key !== 'Escape') return;
    ev.preventDefault();
    ev.stopPropagation(); // the press owns Escape (no deselect / dialog close)
    stop(true);
  }
  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', lost, true);
  window.addEventListener('keydown', key, true);
  window.addEventListener('blur', lost);
  sel.addEventListener('lostpointercapture', lost);
  activePress = { owner: sel, stop };
}

/** Drop-in `<select>`: same props, children and change events; press + drag scrubs, a click opens the list. */
export function ScrubSelect(props: JSX.IntrinsicElements['select']) {
  const { onPointerDown, onMouseDown, ...rest } = props;
  const ref = useRef<HTMLSelectElement>(null);
  const latest = useRef(props);
  latest.current = props;
  useEffect(() => {
    const el = ref.current; // (the ref is already cleared when the cleanup runs)
    return () => {
      if (activePress?.owner === el) activePress.stop(false); // unmounted mid-drag: keep the value, end the gesture
      if (list?.sel === el) closeList();
    };
  }, []);
  return (
    <select {...rest} ref={ref}
      onPointerDown={(e) => {
        (onPointerDown as ((e: PointerEvent) => void) | undefined)?.(e);
        pressSelect(e, e.currentTarget as HTMLSelectElement, () => {
          const v = latest.current.value as unknown;
          return v === undefined || v === null || Array.isArray(v) ? undefined : String(v);
        });
      }}
      onMouseDown={(e) => {
        (onMouseDown as ((e: MouseEvent) => void) | undefined)?.(e);
        const t = e.currentTarget as HTMLSelectElement;
        if (e.button === 0 && !t.disabled) e.preventDefault(); // pointerdown already did; engines that still send mousedown must not open the native popup
      }} />
  );
}

// ---- ScrubNumber ----

export interface ScrubNumberProps extends Omit<JSX.IntrinsicElements['input'], 'value' | 'min' | 'max' | 'step' | 'type' | 'onChange' | 'onInput' | 'onPointerDown'> {
  value: number;
  min: number;
  max: number;
  /** The value snaps to multiples of `step` (default 1). */
  step?: number;
  /** Value units per pixel dragged (default 0.5: one unit per 2 px; Shift x10, Alt x0.1). */
  perPx?: number;
  /** Every live value (scrub frames, valid typed values, commit); already clamped and snapped. */
  onChange: (v: number) => void;
}

export function ScrubNumber(props: ScrubNumberProps) {
  const { value, min, max, step = 1, perPx = 0.5, onChange, onKeyDown, onBlur, ...rest } = props;
  const cur = useRef(props);
  cur.current = props;
  const typing = useRef<{ orig: number; last: number } | null>(null); // a typing edit in progress (one history step)
  const pend = useRef<number | null>(null); // a typed value waiting for its frame
  const rafT = useRef(0);
  const stopScrub = useRef<((cancel: boolean) => void) | null>(null);

  const emit = (v: number) => cur.current.onChange(v);
  const modelValue = () => snap(cur.current.value, cur.current.step ?? 1, cur.current.min, cur.current.max);
  const applyTyped = (v: number) => {
    const t = typing.current;
    if (!t) {
      const orig = modelValue();
      if (v === orig) return;
      store.beginGesture();
      typing.current = { orig, last: v };
    } else if (t.last === v) return;
    else t.last = v;
    emit(v);
  };
  const flushTyped = (apply: boolean) => {
    if (rafT.current) cancelAnimationFrame(rafT.current);
    rafT.current = 0;
    const p = pend.current;
    pend.current = null;
    if (apply && p !== null) applyTyped(p);
  };
  /** Ends the typing step; returns the number the box should show (the model's own when an external edit took over). */
  const endTyping = (cancel: boolean): number | null => {
    flushTyped(!cancel);
    const t = typing.current;
    typing.current = null;
    if (!t) return null;
    const undo = cancel || t.last === t.orig;
    const r = store.endGesture(undo);
    if (!undo) return null;
    if (r === 'kept') return modelValue();
    if (t.last !== t.orig) emit(t.orig);
    return t.orig;
  };
  useEffect(() => () => { stopScrub.current?.(false); endTyping(false); }, []); // unmounted mid-edit: keep the value

  const press = (e: PointerEvent) => {
    const input = e.currentTarget as HTMLInputElement;
    if (e.button !== 0 || e.pointerType === 'touch' || input.disabled || input.readOnly) return;
    if (document.activeElement === input) return; // already typing: a normal text-box press
    activePress?.stop(false);
    const x0 = e.clientX, y0 = e.clientY, id = e.pointerId;
    const lo = cur.current.min, hi = cur.current.max, st = cur.current.step ?? 1, k = cur.current.perPx ?? 0.5;
    const orig = snap(cur.current.value, st, lo, hi);
    const cursor0 = input.style.cursor;
    let acc = orig, last = orig, applied = orig, lastY = y0, scrubbing = false, raf = 0, ended = false;
    try { input.setPointerCapture(id); } catch { /* synthetic pointer */ }
    const flush = () => {
      raf = 0;
      if (last !== applied) { applied = last; emit(applied); }
    };
    const stop = (cancel: boolean) => {
      if (ended) return;
      ended = true;
      stopScrub.current = null;
      activePress = null;
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', lost, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('selectstart', noSelect, true);
      window.removeEventListener('blur', lost);
      input.removeEventListener('lostpointercapture', lost);
      try { input.releasePointerCapture(id); } catch { /* not captured */ }
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      input.style.cursor = cursor0;
      if (!scrubbing) return;
      if (cancel) last = orig;
      else flush();
      const undo = cancel || applied === orig;
      const r = store.endGesture(undo);
      if (!undo) return;
      if (r === 'kept') { input.value = String(modelValue()); return; } // an external undo / edit took over: show the model, push nothing
      if (applied !== orig) { applied = orig; emit(orig); }
      input.value = String(orig);
    };
    function noSelect(ev: Event) { ev.preventDefault(); }
    function move(ev: PointerEvent) {
      if (ev.pointerId !== id) return;
      if (ev.buttons === 0) { stop(false); return; } // the button went up unseen: end the drag
      if (!scrubbing) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < SCRUB_START_PX) return;
        scrubbing = true;
        store.beginGesture();
        input.style.cursor = 'ns-resize';
        input.blur();
        getSelection()?.removeAllRanges();
      }
      acc = scrubValue(acc, lastY - ev.clientY, k, { shift: ev.shiftKey, alt: ev.altKey }, lo, hi);
      lastY = ev.clientY;
      last = snap(acc, st, lo, hi);
      input.value = String(last);
      if (!raf) raf = requestAnimationFrame(flush);
    }
    function up(ev: PointerEvent) {
      if (ev.pointerId === id) stop(false);
    }
    function lost() { stop(false); }
    function key(ev: KeyboardEvent) {
      if (ev.key !== 'Escape' || !scrubbing) return;
      ev.preventDefault();
      ev.stopPropagation();
      stop(true);
    }
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', lost, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('selectstart', noSelect, true);
    window.addEventListener('blur', lost);
    input.addEventListener('lostpointercapture', lost);
    stopScrub.current = stop; // (a press that never moves leaves the browser's default focus + caret alone)
    activePress = { owner: input, stop };
  };

  const typed = (raw: string, commit: boolean) => {
    const n = Number(raw);
    if (raw.trim() === '' || !isFinite(n)) return;
    if (!commit && (n < min || n > max)) return; // while typing only valid values apply
    const v = snap(n, step, min, max);
    if (commit) { flushTyped(false); applyTyped(v); return; }
    if (v === (typing.current?.last ?? modelValue()) && pend.current === null) return; // only a changed value applies
    pend.current = v;
    if (!rafT.current) rafT.current = requestAnimationFrame(() => { rafT.current = 0; flushTyped(true); });
  };

  return (
    <input {...(rest as Record<string, unknown>)} type="number" min={min} max={max} step={step} value={value}
      onPointerDown={press}
      onInput={(e) => typed((e.target as HTMLInputElement).value, false)}
      onChange={(e) => {
        const input = e.target as HTMLInputElement;
        typed(input.value, true); // commit (blur / Enter): an out-of-range number clamps
        const n = Number(input.value);
        if (input.value.trim() === '' || !isFinite(n)) input.value = String(cur.current.value);
        else input.value = String(snap(n, step, min, max));
        endTyping(false); // the commit closes the typing step (do not wait for blur)
      }}
      onKeyDown={(e) => {
        (onKeyDown as ((e: KeyboardEvent) => void) | undefined)?.(e);
        const input = e.currentTarget as HTMLInputElement;
        if (e.key === 'Enter') { input.blur(); }
        else if (e.key === 'Escape' && (typing.current || pend.current !== null)) {
          e.preventDefault();
          e.stopPropagation();
          const shown = endTyping(true);
          input.value = String(shown ?? modelValue());
          input.blur();
        }
      }}
      onBlur={(e) => { (onBlur as ((e: FocusEvent) => void) | undefined)?.(e); endTyping(false); }} />
  );
}
