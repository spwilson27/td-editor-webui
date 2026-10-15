import type { RGBA } from './filters';
// "Animated made static" filters (see filters.d.ts for the conventions).  No time dependence: iterative filters take `iterations` (integer,
// clamped to 1..64) and a deterministic seed, and are recomputed only when the input or the parameters change.
export type AnimatedFilter =
  /**
   * Drift glitch: bands of `blockSize` px (document aligned) random-walk over `iterations` steps; at each step a band moves by
   * (u - 0.5) * 2 * amount px with probability `density` %.  Green is shifted by the accumulated offset o, red by o + k, blue by o - k,
   * k = o * rgbShift / amount (the colour split grows with the drift).  Transparent outside, no wrap.
   */
  | {
      type: 'driftGlitch';
      /** steps, integer 1..64 */ iterations: number;
      /** max offset change per step, px, 0..500 (0 = no-op) */ amount: number;
      /** band thickness, px, 1..500 */ blockSize: number;
      /** probability a band moves per step, %, 0..100 (0 = no-op) */ density: number;
      /** red/blue split per `amount` of drift, px, 0..64 */ rgbShift: number;
      /** integer, mod 2^24 */ seed: number;
      /** 'h': horizontal bands shifted along x (default); 'v': vertical bands shifted along y */ axis: 'h' | 'v';
    }
  /**
   * Feedback trail frozen after `iterations` frames: layers T^i(input) * decay^i, i = 0..iterations-1, where T scales by `scale` % and rotates
   * by `rotate` deg about the centre then translates by (dx, dy) px.  blend: 'over' (newer behind older), 'add', 'lighten', 'screen'.
   * No-op for iterations 1 or decay 0.
   */
  | {
      type: 'feedback';
      /** frames, integer 1..64 */ iterations: number;
      /** px per iteration, -500..500 (right +) */ dx: number;
      /** px per iteration, -500..500 (down +) */ dy: number;
      /** deg per iteration, -180..180, clockwise on screen */ rotate: number;
      /** % per iteration, 50..200 */ scale: number;
      /** opacity multiplier per iteration, %, 0..100 */ decay: number;
      blend: 'over' | 'add' | 'lighten' | 'screen';
      /** transform centre, fraction of document width, 0..1 */ centerX: number;
      /** transform centre, fraction of document height, 0..1 */ centerY: number;
    }
  /**
   * Echo: translation-only feedback.  Echo i is the input shifted by i * (dx, dy) px with opacity decay^i ('exp') or max(0, 1 - i * (1 - decay)) ('linear').
   * No-op for iterations 1 or decay 0.
   */
  | {
      type: 'echo';
      /** echoes including the original, integer 1..64 */ iterations: number;
      /** px per echo, -500..500 */ dx: number;
      /** px per echo, -500..500 */ dy: number;
      /** opacity multiplier per echo, %, 0..100 */ decay: number;
      blend: 'over' | 'add' | 'lighten';
      fade: 'linear' | 'exp';
    }
  /**
   * Colour cycle (static palette-cycling frame): iterated YIQ hue rotation by hueStep * (1 + lumaWarp * (2 * luma - 1)) per step, luma re-evaluated
   * after every step; `bands` snaps the accumulated phase.  Alpha unchanged; hueStep 0 = no-op.
   */
  | {
      type: 'colorCycle';
      /** steps, integer 1..64 */ iterations: number;
      /** deg per iteration, -180..180 */ hueStep: number;
      /** %, 0..100 */ lumaWarp: number;
      /** final chroma boost, %, 0..100 */ saturationBoost: number;
      /** 0 or 1 = smooth, 2..64 = phase steps per turn */ bands: number;
    };
