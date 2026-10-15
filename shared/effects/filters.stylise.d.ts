import type { RGBA } from './filters';
// stylise filters (see filters.d.ts for the conventions).  Lengths in document px, percentages 0..100 (or the stated range), angles in degrees.
export type StyliseFilter =
  /** Photoshop-style relief: relief = amount * (luma(p - L*height) - luma(p + L*height)); gray = 0.5 + relief, overlay = original + relief. Alpha kept. */
  | { type: 'emboss';
      angle: number /* deg -360..360, 0 = light from the right, counter-clockwise on screen (90 = from above) */;
      height: number /* px 1..10, sample distance on each side */;
      amount: number /* % 0..500 */;
      mode: 'gray' | 'overlay' }
  /** 3x3 edge detection on the luma of the premultiplied colour. edges: grey edge map (invert: 1 - e); overlay: original + e (invert: original - e). */
  | { type: 'edgeDetect';
      method: 'sobel' | 'laplacian';
      strength: number /* % 0..500 */;
      threshold: number /* 0..1, edge values below it become 0 (after strength) */;
      invert: boolean;
      mode: 'edges' | 'overlay' }
  /** Kuwahara oil paint, 4 classic quadrants; radii above 6 px stride-subsample the window (max 13x13 taps). */
  | { type: 'kuwahara'; radius: number /* px 1..16 */ }
  /** Square cells aligned to the document origin. mean: cell average (<= 16x16 deterministic taps), centre: centre pixel. */
  | { type: 'pixelate'; size: number /* px 1..256 */; shape?: 'square'; sample: 'mean' | 'centre' }
  /** Quantise to `levels` per channel: ordered Bayer or windowed (approximate, integer, deterministic) Floyd-Steinberg. */
  | { type: 'dither';
      mode: 'ordered' | 'diffusion';
      levels: number /* 2..16 values per channel */;
      matrix: 2 | 4 | 8 /* Bayer size in px, ordered mode only */;
      colour: boolean /* false = quantise the luma and output grey */;
      strength: number /* % 0..100, mix with the original */ }
  /** CRT monitor: scanlines, phosphor mask, barrel curvature (black bezel), vignette, bright-part glow. */
  | { type: 'crt';
      scanlines: number /* % 0..100 */;
      scanlinePeriod: number /* px 2..16 */;
      mask: 'none' | 'aperture' | 'slot';
      maskStrength: number /* % 0..100 */;
      curvature: number /* % 0..100 */;
      vignette: number /* % 0..100 */;
      glow: number /* % 0..100, 5x5 box glow of the bright part */ }
  /** Additive grain per cell (document aligned); film = luma weighted gaussian-ish, noise = uniform. Alpha kept, transparent stays transparent. */
  | { type: 'grain';
      amount: number /* % 0..100 */;
      size: number /* px 1..16, grain cell */;
      kind: 'film' | 'noise';
      colour: boolean /* per-channel noise vs monochrome */;
      seed: number /* integer */ }
  /** Bloom: blurred bright pass, tinted, screen blended (premultiplied). */
  | { type: 'bloom';
      threshold: number /* 0..1 luma */;
      knee: number /* 0..1 */;
      radius: number /* px 0..200 */;
      intensity: number /* % 0..300 */;
      tint: RGBA /* straight 0..255, default white; alpha scales the intensity */ };
