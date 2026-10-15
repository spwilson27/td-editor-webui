// Raster Editor v6 filters library -- helpers shared by the filter shaders (docs/DESIGN_V6.md section 1, filters.d.ts).
// Concatenated AFTER common.glsl (and before blurlib.glsl when a filter lists it in "include"), never touched by the v5 effects.
//
// Extra conventions on top of common.glsl
//   * sTD2DInputs[2] (only shaders whose spec says "in2": true; then EVERY pass of that shader has it wired, and in2lib.glsl -- fxData()/fxAux2() --
//     is appended automatically; shaders WITHOUT in2 must not mention index 2: TD's GLSL TOP has only 2 inputs there and fails to compile):
//       - a DATA texture (curve / gradient / LUT / table): RGBA8, read with fxData(x, y) in raw texel coordinates (row 0 first row of
//         the planner's data array, no flip), or
//       - the AUX image (displace by another layer / input): document sized like input 0, read with fxAux2(f) in fx coordinates.
//   * uPass = (pass id, region origin x, region origin y, level + 0.5 * auxMissing)  -> fxLevel(), fxAuxMissing()
//   * uSize = (logical region w, h, document w, h); zeros = "the texture size" (TD: the chain texture IS the document)
//   * Colour maths is done on STRAIGHT colour in the stored (sRGB-encoded) values; the filter output is premultiplied again.
//   * Every random value derives from fxHash of integer inputs (document coordinates, seed, index): no time, no textures,
//     identical on every GPU and independent of the rendered region.

int fxLevel() { return int(floor(uPass.w + 0.25)); }
bool fxAuxMissing() { return fract(uPass.w) > 0.25; }
ivec2 fxDocSize() { return uSize.z > 0.5 ? ivec2(int(uSize.z + 0.5), int(uSize.w + 0.5)) : fxTexSize(); }

vec4 fxPm(vec3 rgb, float a) { return vec4(rgb * a, a); }
vec3 fxHsv(vec3 c) {
    float mx = max(max(c.r, c.g), c.b);
    float mn = min(min(c.r, c.g), c.b);
    float d = mx - mn;
    return vec3(fxHue(c), mx > 1e-6 ? d / mx : 0.0, mx);
}
vec3 fxFromHsv(vec3 h) {
    vec3 k = clamp(abs(mod(h.x * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
    return h.z * mix(vec3(1.0), k, h.y);
}

// ---- deterministic noise (document coordinates + seed)
uint fxHash2(ivec2 p, uint seed) {
    return fxHash(uint(p.x) * 0x9e3779b1u ^ fxHash(uint(p.y) * 0x85ebca6bu + seed * 0xc2b2ae35u + 0x27d4eb2fu));
}
float fxRand2(ivec2 p, uint seed) { return float(fxHash2(p, seed) & 0xffffffu) / 16777216.0; }
// smooth value noise in [0,1), lattice spacing 1
float fxVNoise(vec2 q, uint seed) {
    vec2 fl = floor(q);
    ivec2 i = ivec2(int(fl.x), int(fl.y));
    vec2 w = q - fl;
    w = w * w * (3.0 - 2.0 * w);
    return mix(mix(fxRand2(i, seed), fxRand2(i + ivec2(1, 0), seed), w.x),
               mix(fxRand2(i + ivec2(0, 1), seed), fxRand2(i + ivec2(1, 1), seed), w.x), w.y);
}
float fxFbm(vec2 q, uint seed, int octaves) {
    float a = 0.5, s = 0.0, n = 0.0;
    for (int o = 0; o < 8; o++) {
        if (o >= octaves) break;
        s += a * fxVNoise(q, seed + uint(o) * 101u);
        n += a;
        q = q * 2.0 + vec2(17.0, 9.0);
        a *= 0.5;
    }
    return s / max(n, 1e-6);
}

// ---- sampling the effect input at a continuous DOCUMENT position with an edge mode (0 transparent, 1 clamp, 2 mirror, 3 wrap).
// The edge mode is applied PER TAP (integer texel index), then the 4 taps are blended bilinearly: no transparency leaks across the seams of
// the mirror / wrap / clamp modes (an opaque document stays opaque).
int fxMapIdx(int p, int n, int edge) {
    if (edge == 1) return clamp(p, 0, n - 1);
    if (edge == 2) {
        int m = ((p % (2 * n)) + 2 * n) % (2 * n);
        return m < n ? m : 2 * n - 1 - m;
    }
    if (edge == 3) return ((p % n) + n) % n;
    return p;
}
vec4 fxTapDoc(ivec2 p, int edge) {
    ivec2 D = fxDocSize();
    if (edge == 0 && (p.x < 0 || p.y < 0 || p.x >= D.x || p.y >= D.y)) return vec4(0.0);
    ivec2 q = ivec2(fxMapIdx(p.x, D.x, edge), fxMapIdx(p.y, D.y, edge));
    return fxSrc(q - ivec2(int(uPass.y + 0.5), int(uPass.z + 0.5)));
}
vec4 fxSampleDoc(vec2 qd, int edge) {
    vec2 t = qd - 0.5;
    vec2 fl = floor(t);
    ivec2 i = ivec2(int(fl.x), int(fl.y));
    vec2 w = t - fl;
    return mix(mix(fxTapDoc(i, edge), fxTapDoc(i + ivec2(1, 0), edge), w.x),
               mix(fxTapDoc(i + ivec2(0, 1), edge), fxTapDoc(i + ivec2(1, 1), edge), w.x), w.y);
}

// ---- deterministic trigonometry.  The GPU sin / cos / atan differ in the last bits (and more on software rasterisers); where a filter maps
// coordinates with them, a 1e-3 px difference on a steep edge is several levels.  These use only + - * / sqrt (identical results on every
// GPU up to FMA contraction ~1e-7): |error| < 2e-7 for |x| < 100.
float fxSin(float x) {
    const float TAU_HI = 6.28125;               // 2 pi = TAU_HI + TAU_LO (Cody-Waite reduction)
    const float TAU_LO = 0.0019353071795864769;
    float k = floor(x * 0.15915494309189535 + 0.5);
    float r = (x - k * TAU_HI) - k * TAU_LO;     // [-pi, pi]
    if (r > 1.5707963267948966) r = 3.141592653589793 - r;
    else if (r < -1.5707963267948966) r = -3.141592653589793 - r;
    float r2 = r * r;
    return r * (1.0 + r2 * (-1.0 / 6.0 + r2 * (1.0 / 120.0 + r2 * (-1.0 / 5040.0 + r2 * (1.0 / 362880.0 + r2 * (-1.0 / 39916800.0))))));
}
float fxCos(float x) { return fxSin(x + 1.5707963267948966); }
float fxAtan(float t) {                           // arctan, |t| any: two half-angle reductions, then the Taylor series on |t| < 0.2
    float s = t < 0.0 ? -1.0 : 1.0;
    float a = abs(t);
    bool inv = a > 1.0;
    if (inv) a = 1.0 / a;
    a = a / (1.0 + sqrt(1.0 + a * a));
    a = a / (1.0 + sqrt(1.0 + a * a));            // atan(a0) = 4 atan(a2), a2 <= tan(pi/16) = 0.199
    float a2 = a * a;
    float r = a * (1.0 + a2 * (-1.0 / 3.0 + a2 * (1.0 / 5.0 + a2 * (-1.0 / 7.0 + a2 * (1.0 / 9.0 + a2 * (-1.0 / 11.0))))));
    r *= 4.0;
    if (inv) r = 1.5707963267948966 - r;
    return s * r;
}
float fxAtan2(float y, float x) {
    if (x == 0.0 && y == 0.0) return 0.0;
    if (abs(y) <= abs(x)) {
        float a = fxAtan(y / x);
        return x > 0.0 ? a : (y >= 0.0 ? a + 3.141592653589793 : a - 3.141592653589793);
    }
    float a = fxAtan(x / y);
    return y > 0.0 ? 1.5707963267948966 - a : -1.5707963267948966 - a;
}
// exact integer straight 8-bit colour of a premultiplied sample (round half up of 255 k / m): quantisers must not depend on float division
ivec3 fxStraightI(vec4 c) {
    ivec4 q = ivec4(floor(c * 255.0 + 0.5));
    if (q.a <= 0) return ivec3(0);
    return min((q.rgb * 510 + q.a) / (2 * q.a), ivec3(255));
}
