/** v7: the classic adjustments that are FX types. The compositor computes them with adjustments.ts maths (the effects module has them too, within 1/255, but a GL round trip costs more). */
export const CLASSIC_EFFECT_TYPES: ReadonlySet<string> = new Set(['levels', 'brightnessContrast', 'hueSaturation', 'invert', 'threshold']);
