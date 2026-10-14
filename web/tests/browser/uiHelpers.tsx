import { render, type ComponentChildren } from 'preact';
import { store } from '../../src/state/store';
import { FakeEngine } from './fakeEngine';

import '../../src/ui/styles.css';

let host: HTMLElement | null = null;

export const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
/** Lets Preact flush signal-driven renders and queued rAF draws. */
export async function settle() { await frame(); await frame(); }

export function freshEngine(w = 64, h = 48): FakeEngine {
  const engine = new FakeEngine(w, h);
  store.attach(engine);
  return engine;
}

export async function mount(ui: ComponentChildren, style = ''): Promise<HTMLElement> {
  unmount();
  host = document.createElement('div');
  host.id = 'app';
  host.style.cssText = `font:12px sans-serif;color:#e3e3e3;background:#2b2b2b;${style}`;
  document.body.appendChild(host);
  render(ui, host);
  await settle();
  return host;
}

export function unmount() {
  if (host) { render(null, host); host.remove(); host = null; }
}

export function ptr(type: string, init: PointerEventInit = {}): PointerEvent {
  return new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, ...init });
}

export function drag(el: Element, from: [number, number], to: [number, number], steps = 4) {
  el.dispatchEvent(ptr('pointerdown', { clientX: from[0], clientY: from[1], buttons: 1 }));
  for (let i = 1; i <= steps; i++) {
    const x = from[0] + ((to[0] - from[0]) * i) / steps, y = from[1] + ((to[1] - from[1]) * i) / steps;
    el.dispatchEvent(ptr('pointermove', { clientX: x, clientY: y, buttons: 1 }));
  }
  el.dispatchEvent(ptr('pointerup', { clientX: to[0], clientY: to[1] }));
}

export const centre = (el: Element): [number, number] => {
  const r = el.getBoundingClientRect();
  return [r.left + r.width / 2, r.top + r.height / 2];
};

export const q = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T => {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
};
