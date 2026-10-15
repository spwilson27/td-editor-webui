// Distort filters (see filters.d.ts for the conventions).
// All coordinate-mapping filters below are ONE pass, out(p) = in(map(p)) with bilinear resampling at DOCUMENT coordinates (pixel centres at
// integer + 0.5); centres are FRACTIONS of the document size (0.5 = middle); `edge` selects what is read outside the document.
export type DistortEdge = 'transparent' | 'clamp' | 'mirror' | 'wrap';

export type DistortFilter =
  /** out(p) = in(p + offset(p)); offset from value noise (source 'noise') or the chain's aux image (source 'aux', 0.5 = no shift). */
  | { type: 'displace'; source: 'noise' | 'aux'; strengthX: number /* px -500..500 */; strengthY: number /* px -500..500 */;
      scale: number /* noise feature size px 1..4000 */; octaves: number /* 1..6 */; seed: number; edge: 'transparent' | 'clamp' | 'mirror' | 'wrap' }
  /** Rotates the content around the centre by `angle` (clockwise for positive values) with a cubic smoothstep falloff to 0 at `radius`. angle 0 = no-op. */
  | { type: 'twirl'; angle: number /* degrees -3600..3600 */; radius: number /* px 1..4000 */;
      centerX: number /* fraction of document width, default 0.5 */; centerY: number /* fraction of document height, default 0.5 */; edge: DistortEdge }
  /** kind 'wave': pixels move perpendicular to the wave direction `angle` by amplitude * sin(2 pi (p . dir) / wavelength + phase);
   *  kind 'ripple': pixels move radially from the centre by amplitude * g(r) * sin(2 pi r / wavelength + phase), g = exp(-5 decay/100 r / halfDiagonal). amplitude 0 = no-op. */
  | { type: 'ripple'; kind: 'wave' | 'ripple'; amplitude: number /* px 0..200 */; wavelength: number /* px 2..2000 */; phase: number /* degrees -3600..3600 */;
      angle: number /* degrees, wave direction (kind wave) */; centerX: number /* fraction */; centerY: number /* fraction */;
      decay: number /* percent 0..100 (kind ripple) */; edge: DistortEdge }
  /** Radial lens model r' = r (1 + k1 r^2 + k2 r^4) with r in units of the half document diagonal (r = 1 at the corners of a centred document);
   *  evaluated as the INVERSE mapping per output pixel: the pixel at radius r reads the source at radius r' / zoom. k1 > 0 barrel, k1 < 0 pincushion.
   *  k1 = k2 = 0 and scale 100 = no-op. */
  | { type: 'lensDistortion'; k1: number /* percent -100..100 (coefficient k1/100) */; k2: number /* percent -100..100 (coefficient k2/100) */;
      scale: number /* percent zoom 50..200 */; centerX: number /* fraction */; centerY: number /* fraction */; edge: DistortEdge }
  /** rectToPolar wraps the image's x axis around the centre (top row at the centre, bottom row at radius R = radiusScale/100 * min(W,H)/2);
   *  polarToRect is the inverse. Angles are clockwise from 'up'. */
  | { type: 'polar'; mode: 'rectToPolar' | 'polarToRect'; centerX: number /* fraction */; centerY: number /* fraction */;
      angleOffset: number /* degrees -3600..3600 */; radiusScale: number /* percent 10..400 */; edge: DistortEdge }
  /** Mirror-folds the polar angle around the centre into wedges of 360/segments degrees (each holding a source half-wedge and its mirror image). */
  | { type: 'kaleidoscope'; segments: number /* integer 2..32 */; angle: number /* degrees, rotates the source wedge */;
      centerX: number /* fraction */; centerY: number /* fraction */; zoom: number /* percent 25..400 */; edge: DistortEdge }
  /** Repeats the whole document tilesX x tilesY times inside the document (each tile = the full image scaled down); mirror flips alternate tiles.
   *  The tile grid is shifted by offsetX/offsetY percent of a tile and rotated (clockwise) by `rotation` degrees about the document centre.
   *  1x1 tile, no offset/rotation = no-op. */
  | { type: 'tileMirror'; tilesX: number /* integer 1..32 */; tilesY: number /* integer 1..32 */; mirror: boolean;
      offsetX: number /* percent of tile width 0..100 */; offsetY: number /* percent of tile height 0..100 */; rotation: number /* degrees -3600..3600 */; edge: DistortEdge };
