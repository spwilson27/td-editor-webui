// Raster Editor v5 layer effects -- shared prelude (docs/DESIGN_V5.md "Layer effects").
// Concatenated in front of every effect shader: `common.glsl + <effect>.glsl`.  Written for the common subset of
// GLSL 3.30 (TouchDesigner GLSL TOP) and GLSL ES 3.00 (WebGL2).  The ONLY per-host code is the adapter header:
//   TD:     none (the GLSL TOP injects sTD2DInputs[], uTDOutputInfo, TDOutputSwizzle)
//   WebGL2: "#version 300 es", precision, `#define TDOutputSwizzle(x) (x)` and `uniform sampler2D sTD2DInputs[2];`
//           (web/src/engine/effects/gl.ts)
//
// Conventions (identical in both hosts)
//   * Two inputs are ALWAYS wired: sTD2DInputs[0] = the effect's input (layer content, PREMULTIPLIED rgba, document
//     sized or a document sub-rect "region") and sTD2DInputs[1] = the previous pass of this effect (pass 0: the same
//     texture as input 0).  The output is premultiplied rgba (intermediate passes: pass specific data, see each file).
//   * Texture row 0 is the BOTTOM row (GL / TD).  Effect code never sees that: it works in "fx coordinates"
//     f = region-local integer pixel, origin TOP-left, y down (= document orientation).  fxPos() / fxSrc() / fxAux()
//     do the flip.  Document coordinates = f + (uPass.y, uPass.z) (region origin; 0,0 in TD).
//   * Outside the texture every fetch returns vec4(0) (transparent).  Fetches are texelFetch only (no filtering),
//     so TD's input filter / extend settings are irrelevant and both hosts read exactly the same texels.
//   * Uniforms: uP0..uP3 = 16 effect parameters (meaning per effect file, produced by plan_effect() in
//     td/raster_editor/effects.py == planEffect() in web/src/engine/effects/plan.ts), uPass.x = pass id,
//     uPass.yz = region origin (document px).  Lengths are document px, colours straight rgb 0..1 with the
//     effect's opacity already multiplied into alpha.

out vec4 fragColor;

uniform vec4 uP0;
uniform vec4 uP1;
uniform vec4 uP2;
uniform vec4 uP3;
uniform vec4 uPass;
uniform vec4 uSize;   // xy = logical region size in px when the texture is larger (WebGL size buckets); 0 = the texture size (TD)

const float FX_PI = 3.14159265358979;

ivec2 fxTexSize() { return textureSize(sTD2DInputs[0], 0); }
// logical region size: everything outside it (also the padding of a larger texture) is transparent
ivec2 fxSize() { return uSize.x > 0.5 ? ivec2(int(uSize.x + 0.5), int(uSize.y + 0.5)) : fxTexSize(); }
ivec2 fxPos() {
    ivec2 s = fxTexSize();
    return ivec2(int(gl_FragCoord.x), s.y - 1 - int(gl_FragCoord.y));
}
int fxPass() { return int(uPass.x + 0.5); }
ivec2 fxDoc(ivec2 f) { return f + ivec2(int(uPass.y + 0.5), int(uPass.z + 0.5)); }

bool fxIn(ivec2 f, ivec2 s) { return f.x >= 0 && f.y >= 0 && f.x < s.x && f.y < s.y; }

vec4 fxSrc(ivec2 f) {
    if (!fxIn(f, fxSize())) return vec4(0.0);
    return texelFetch(sTD2DInputs[0], ivec2(f.x, fxTexSize().y - 1 - f.y), 0);
}
vec4 fxAux(ivec2 f) {
    if (!fxIn(f, fxSize())) return vec4(0.0);
    return texelFetch(sTD2DInputs[1], ivec2(f.x, fxTexSize().y - 1 - f.y), 0);
}

// bilinear fetch of the effect input at a continuous position q (fx coordinates, pixel centres at +0.5)
vec4 fxSrcLinear(vec2 q) {
    vec2 t = q - 0.5;
    vec2 fl = floor(t);
    ivec2 i = ivec2(int(fl.x), int(fl.y));
    vec2 w = t - fl;
    return mix(mix(fxSrc(i), fxSrc(i + ivec2(1, 0)), w.x),
               mix(fxSrc(i + ivec2(0, 1)), fxSrc(i + ivec2(1, 1)), w.x), w.y);
}

void fxOut(vec4 c) { fragColor = TDOutputSwizzle(c); }

// normalised gaussian tap weight helper: exp(-i^2 / (2 s^2)); s <= 0 -> only the centre tap
float fxGauss(float i, float s) {
    if (s <= 1e-4) return i == 0.0 ? 1.0 : 0.0;
    return exp(-0.5 * i * i / (s * s));
}

float fxLuma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec3 fxStraight(vec4 c) { return c.a > 1e-6 ? clamp(c.rgb / c.a, 0.0, 1.0) : vec3(0.0); }

float fxHue(vec3 c) {
    float mx = max(max(c.r, c.g), c.b);
    float mn = min(min(c.r, c.g), c.b);
    float d = mx - mn;
    if (d < 1e-6) return 0.0;
    float h;
    if (mx == c.r) h = mod((c.g - c.b) / d, 6.0);
    else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
    else h = (c.r - c.g) / d + 4.0;
    return h / 6.0;
}

// integer hash (Wang/Murmur-style finaliser); identical on every GPU (pure uint arithmetic)
uint fxHash(uint x) {
    x ^= x >> 16;
    x *= 0x7feb352du;
    x ^= x >> 15;
    x *= 0x846ca68bu;
    x ^= x >> 16;
    return x;
}
float fxRand(uint h) { return float(h & 0xffffu) / 65536.0; }
