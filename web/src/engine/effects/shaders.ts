// Shader sources shared with TouchDesigner (shared/effects/*.glsl); the WebGL2 adapter header is added in gl.ts.
import { FILTER_SPECS } from './filters';

const raws = import.meta.glob('../../../../shared/effects/*.glsl', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const src = (name: string): string => {
  const t = raws[`../../../../shared/effects/${name}.glsl`];
  if (t === undefined) throw new Error('missing shader ' + name);
  return t;
};

// v5 effects whose blur passes use the pyramid helpers; filters list their libraries in the spec ("include", default filterlib)
const LEGACY_INCLUDES: Record<string, string[]> = {
  dropShadow: ['filterlib', 'blurlib'], outerGlow: ['filterlib', 'blurlib'], innerGlow: ['filterlib', 'blurlib'], bevel: ['filterlib', 'blurlib'],
};
export const shaderIncludes = (name: string): string[] => {
  const sp = FILTER_SPECS[name];
  if (!sp) return LEGACY_INCLUDES[name] ?? [];
  const inc = sp.include ?? ['filterlib'];
  return sp.in2 && !inc.includes('in2lib') ? [...inc, 'in2lib'] : inc; // fxData() / fxAux2(): only shaders with a third input
};

/** Fragment shader body (without the host adapter) of a shader: common.glsl + its libraries + <name>.glsl (== effects.py load_shader_texts). */
export function shaderBody(name: string): string {
  return src('common') + '\n' + shaderIncludes(name).map((i) => src(i) + '\n').join('') + src(name);
}

/** The part TouchDesigner's GLSL TOP injects itself. */
export const WEBGL_ADAPTER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
#define TDOutputSwizzle(x) (x)
uniform sampler2D sTD2DInputs[3];
`;
