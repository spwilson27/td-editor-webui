/** Pointer capture can throw for synthetic or already-released pointers (and some embedded browsers); dragging still works without it. */
export function capture(el: Element, pointerId: number): void {
  try { el.setPointerCapture(pointerId); } catch { /* ignore */ }
}
