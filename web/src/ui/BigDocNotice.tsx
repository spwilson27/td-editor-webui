import { BIG_DOC_PIXELS, store } from '../state/store';

/** One-time suggestion (never an automatic switch) to try the TouchDesigner view for documents above ~8 MP. Dismissal is remembered per viewer. */
export function BigDocNotice() {
  if (!store.bigDocNotice.value) return null;
  const { w, h } = store.docSize.value;
  const mp = (w * h) / 1e6;
  const linked = store.tdAvailable.value;
  return (
    <div data-bigdoc-notice role="status" style="flex:none;display:flex;align-items:center;gap:12px;padding:5px 12px;background:#3a3320;border-bottom:1px solid #1a1a1a;color:#f0dca8">
      <span style="flex:1 1 auto;min-width:0">
        This document is {mp.toFixed(1)} MP (over {BIG_DOC_PIXELS / 1e6} MP). The Local preview can feel slow at this size; the TouchDesigner view renders it on the GPU.
        {!linked && ' It needs a TouchDesigner connection.'}
      </span>
      <button data-bigdoc-td aria-disabled={!linked} title={linked ? 'Show TouchDesigner’s output' : 'Needs a TouchDesigner connection'} onClick={() => store.acceptBigDocNotice()}
        style={`height:22px;padding:0 10px;border:1px solid #6b5a2a;border-radius:4px;background:#4a4026;color:${linked ? '#fff' : '#9a8f6a'}`}>Try TD view</button>
      <button data-bigdoc-dismiss onClick={() => store.dismissBigDocNotice()} style="height:22px;padding:0 10px;border:1px solid #6b5a2a;border-radius:4px;color:#f0dca8">Don’t show again</button>
    </div>
  );
}
