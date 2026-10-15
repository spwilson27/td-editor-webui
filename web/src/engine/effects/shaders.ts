// Shader sources shared with TouchDesigner (shared/effects/*.glsl); the WebGL2 adapter header is added in gl.ts.
import common from '../../../../shared/effects/common.glsl?raw';
import dropShadow from '../../../../shared/effects/dropShadow.glsl?raw';
import outerGlow from '../../../../shared/effects/outerGlow.glsl?raw';
import innerGlow from '../../../../shared/effects/innerGlow.glsl?raw';
import stroke from '../../../../shared/effects/stroke.glsl?raw';
import bevel from '../../../../shared/effects/bevel.glsl?raw';
import colorOverlay from '../../../../shared/effects/colorOverlay.glsl?raw';
import pixelSort from '../../../../shared/effects/pixelSort.glsl?raw';
import glitch from '../../../../shared/effects/glitch.glsl?raw';
import chromaticAberration from '../../../../shared/effects/chromaticAberration.glsl?raw';
import halftone from '../../../../shared/effects/halftone.glsl?raw';
import type { EffectType } from '../types';

const bodies: Record<EffectType, string> = {
  dropShadow, outerGlow, innerGlow, stroke, bevel, colorOverlay, pixelSort, glitch, chromaticAberration, halftone,
};

/** Fragment shader body (without the host adapter) of an effect type: common.glsl + <type>.glsl. */
export function shaderBody(type: EffectType): string {
  return common + '\n' + bodies[type];
}

/** The part TouchDesigner's GLSL TOP injects itself. */
export const WEBGL_ADAPTER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
#define TDOutputSwizzle(x) (x)
uniform sampler2D sTD2DInputs[2];
`;
