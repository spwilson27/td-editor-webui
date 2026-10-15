// Blur & sharpen filters (see filters.d.ts for the conventions and the blur pyramid note).
export type BlurFilter =
  /** Gaussian blur; radius = kernel half width (sigma = radius / 3). threshold/knee: blur only the bright part (bloom building block). */
  | {
      type: 'blur'; radius: number /* px 0..200 */; threshold?: number /* 0..1, 0 = all */; knee?: number /* 0..1 */;
      /** v7: > 0 overrides `radius`: gaussian sigma in px 0..200 (kernel half width 4 sigma while <= 16 px, else 3 sigma, up to 600 px). Default 0 = radius / 3. */
      sigma?: number;
      /** v7: outside the document: 'transparent' (default) or 'hold' (repeat the edge pixels; the v6 adjustment blur). Works in the pyramid and for regions. */
      edge?: 'transparent' | 'hold';
    }
  /** out = src + amount * (src - blur) where |src - blur| >= threshold. */
  | { type: 'unsharp'; amount: number /* % 0..500 */; radius: number /* px 0..200 */; threshold: number /* levels 0..255 */ }
  /** straight colour = 0.5 + (src - blur); alpha kept. */
  | { type: 'highPass'; radius: number /* px 0..200 */ }
  /**
   * Box blur along a line through each pixel (premultiplied rgba, no fringing). `length` is the TOTAL streak length, centred on the pixel;
   * `angle` 0 = horizontal, clockwise on screen. Exact smooth box at any length: a box pass (<= 32 taps) followed by a comb pass (<= 13 taps)
   * whose convolution is one box (<= 45 taps per pixel). Extent = length/2 + 4 px along the line.
   */
  | { type: 'motionBlur'; length: number /* px 0..400 */; angle: number /* deg -360..360 */ }
  /**
   * Spin blur: average over an arc around the centre, total arc `amount` degrees centred on each pixel's angle. Tap count = arc length in px
   * at the pixel's radius (<= 64): smooth while radius * amount(rad) <= 64 px, faint stepping beyond. Outside the document = transparent.
   * Reads the whole document (extent = document).
   */
  | { type: 'radialBlur'; amount: number /* deg 0..180 */; centerX: number /* fraction of document width 0..1 */; centerY: number /* fraction of document height 0..1 */ }
  /**
   * Zoom blur: average along the line from each pixel towards the centre, covering `amount` % of its distance to the centre (100 = to the
   * centre). Tap count = streak length in px (<= 64), starting at the pixel itself. Outside the document = transparent. Extent = document.
   */
  | { type: 'zoomBlur'; amount: number /* % 0..100 */; centerX: number /* fraction of document width 0..1 */; centerY: number /* fraction of document height 0..1 */ }
  /**
   * Bokeh lens blur: disc (blades 0) or regular polygon (3..8 blades, circumradius `radius`) kernel via a golden-angle spiral of <= 64 taps,
   * per-pixel rotation jitter from (position, seed). Radii > 8 px use a down-sampled pyramid level (2^L, L = 1..4): kernel edge softened by
   * about 2^L px, fine grain remains. brightness boosts rgb of samples whose luma exceeds `threshold` by up to 1 + 15 * brightness / 100
   * before averaging (result clamped to alpha); 0 = plain average.
   */
  | { type: 'lensBlur'; radius: number /* px 0..100 */; blades: number /* 0 = circle, 3..8 polygon (integer) */; rotation: number /* deg -360..360, clockwise */;
      brightness: number /* % 0..100, 0 = no boost */; threshold: number /* luma 0..1 */; seed: number /* integer */ };
