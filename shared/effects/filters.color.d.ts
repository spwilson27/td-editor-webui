import type { RGBA } from './filters';
// Colour grading filters (see filters.d.ts for the conventions).  All work on STRAIGHT colour in the stored (sRGB encoded) values,
// alpha unchanged, output premultiplied again.  Identity settings do nothing.
export type CurvePoint = [number, number] | { x: number; y: number };
/** Gradient stop: `pos` 0..1, `color` straight RGBA 0..255 (the alpha of a stop is ignored by gradientMap). */
export interface GradientStop { pos: number; color: RGBA }
export type ColorFilter =
  /** Curves: control points x, y in 0..1 (monotone cubic); `master` first, then the per-channel curve; no points = identity. */
  | { type: 'curves'; master?: CurvePoint[]; red?: CurvePoint[]; green?: CurvePoint[]; blue?: CurvePoint[] }
  /** Each channel quantised to `levels` values. */
  | { type: 'posterize'; levels: number /* 2..255 */ }
  /** Rec.709 luma (or 1 - luma when `reverse`) looked up in a gradient; mixed with the original by `amount`.  Default stops black -> white. */
  | { type: 'gradientMap'; stops?: GradientStop[] /* 1..32 stops */; reverse?: boolean; amount?: number /* % 0..100, default 100; 0 = no-op */ }
  /** Photoshop-like colour balance; every value is a % shift, -100..100 (positive = red / green / blue, negative = cyan / magenta / yellow).
   *  Tonal weights from luma L: shadows (1-L)^2, midtones 2L(1-L), highlights L^2.  `preserveLuminosity` (default true) keeps the luma. */
  | {
      type: 'colorBalance';
      shadowsCyanRed?: number; shadowsMagentaGreen?: number; shadowsYellowBlue?: number;
      midtonesCyanRed?: number; midtonesMagentaGreen?: number; midtonesYellowBlue?: number;
      highlightsCyanRed?: number; highlightsMagentaGreen?: number; highlightsYellowBlue?: number;
      preserveLuminosity?: boolean;
    }
  /** v7 point ops, the classic adjustments as filters (same maths and units as the v2 adjustment layers; sRGB encoded straight colour, alpha unchanged). */
  /** `inLow`, `inHigh`, `outLow`, `outHigh` 0..1 (inHigh kept >= inLow + 1e-4), `gamma` 0.1..10 (> 1 brightens mid-tones): out = outLow + (outHigh - outLow) * clamp((c - inLow) / (inHigh - inLow))^(1 / gamma). */
  | { type: 'levels'; inLow?: number; inHigh?: number; gamma?: number; outLow?: number; outHigh?: number }
  /** `brightness` -1..1 MULTIPLIES (c * (1 + b)), `contrast` -1..1 pivots at 0.5. */
  | { type: 'brightnessContrast'; brightness?: number; contrast?: number }
  /** True HSV edit: `hue` degrees -180..180 (+ = red -> green -> blue), `saturation` / `value` multipliers 0..2 (default 1). */
  | { type: 'hueSaturation'; hue?: number; saturation?: number; value?: number }
  /** 1 - c. */
  | { type: 'invert' }
  /** Rec.709 luma of the straight colour >= `level` (0..1, default 0.5) -> white, else black. */
  | { type: 'threshold'; level?: number }
  /** `vibrance` % -100..100 (low-saturation colours move most), `saturation` % -100..100 (-100 = luma grey, +100 = twice the distance from grey). */
  | { type: 'vibrance'; vibrance?: number; saturation?: number }
  /** Matrix rows (R', G', B') = coefficients in % -200..200 (identity 100 on the diagonal) + constants r, g, b in % -100..100.
   *  `monochrome`: all channels = grayRed R + grayGreen G + grayBlue B (% -200..200, default 30 / 59 / 11), matrix ignored. */
  | {
      type: 'channelMixer';
      rr?: number; rg?: number; rb?: number; gr?: number; gg?: number; gb?: number; br?: number; bg?: number; bb?: number;
      r?: number; g?: number; b?: number;
      monochrome?: boolean; grayRed?: number; grayGreen?: number; grayBlue?: number;
    }
  /** 36 numbers -1..1 (= -100..100 %): ranges reds, yellows, greens, cyans, blues, magentas, whites, neutrals, blacks, each cyan, magenta, yellow, black.
   *  `relative` (default true): Photoshop relative method (changes scale with the existing ink), false = absolute. */
  | { type: 'selectiveColor'; adjust?: number[]; relative?: boolean }
  /** Luma mapped onto shadow -> (mid) -> highlight colours (alpha of the colours ignored); `contrast` % -100..100 about mid grey; `amount` % 0..100 mix with the original. */
  | { type: 'duotone'; shadow?: RGBA; highlight?: RGBA; mid?: RGBA; useMid?: boolean; contrast?: number; amount?: number }
  /** Adobe / Resolve `.cube` 3D LUT text (LUT_3D_SIZE 2..64; invalid text or 1D LUT = no-op); `intensity` % 0..100 mix with the original. */
  | { type: 'lut'; cube?: string; intensity?: number };
