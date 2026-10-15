// Raster Editor v6 -- blur pyramid helpers (docs/DESIGN_V6.md "Blur pyramid"; shared/effects/filters.d.ts "Blur quality").
// Concatenated after filterlib.glsl.  Used by every blur-type pass with radius > 16 px (planner: pyrL()).
//
// A pyramid blur of kernel size `px` (sigma = px / 3) with level L >= 1, s = 2^L:
//   D  (level L)  box average of the FIELD over the s x s block of each low-res texel (reads input 0, full res)
//   H  (level L)  horizontal gaussian at low res, sigma_low^2 = (sigma^2 - s^2/4) / s^2, radius ceil(px / s) <= 16  (reads input 1)
//   V  (level L)  vertical gaussian at low res (reads input 1)
//   U  (level 0)  bilinear up-sampling of the low-res result at every full-res pixel (reads input 1; input 0 = the effect input)
// The s^2/4 term compensates the variance added by the box down-sample (s^2/12) and the bilinear up-sample (s^2/6).
// Low-res texel i covers document pixels [(i - 1 + k) * s, (i + k) * s) -- the block grid is aligned to DOCUMENT coordinates (k from the
// region origin), so a partial region render equals the full render.  Texel 0 and the last texel are one-texel MARGINS (they hold the blur
// of what lies just outside the document, which the bilinear up-sample needs at the borders).  Texture size of level L = ceil(texture / s) + 3
// on both hosts; logical size = ceil((region + k) / s) + 2.
// FIELD modes: 0 = (alpha,0,0,1)  1 = (1 - alpha,0,0,1)  2 = premultiplied rgba  3 = bright pass of rgba (uThr: threshold, knee in uBright).

int fxLvlD(int L) { return 1 << L; }
ivec2 fxLvlOff(int L) {
    int d = 1 << L;
    return ivec2(int(uPass.y + 0.5) % d, int(uPass.z + 0.5) % d);
}
ivec2 fxLvlTex(int L) {
    ivec2 s = fxTexSize();
    if (L == 0) return s;
    int d = 1 << L;
    return (s + (d - 1)) / d + 3;
}
ivec2 fxLvlLogical(int L) {
    ivec2 s = fxSize();
    if (L == 0) return s;
    int d = 1 << L;
    return (s + fxLvlOff(L) + (d - 1)) / d + 2;
}
ivec2 fxLvlPos(int L) {
    ivec2 t = fxLvlTex(L);
    return ivec2(int(gl_FragCoord.x), t.y - 1 - int(gl_FragCoord.y));
}
// input 1 = the low-res texture of level L (written by the previous pass)
vec4 fxLvlFetch(ivec2 p, int L, vec4 outside) {
    ivec2 ls = fxLvlLogical(L);
    if (p.x < 0 || p.y < 0 || p.x >= ls.x || p.y >= ls.y) return outside;
    ivec2 t = fxLvlTex(L);
    return texelFetch(sTD2DInputs[1], ivec2(p.x, t.y - 1 - p.y), 0);
}

vec4 fxFieldOf(int mode, vec4 c, vec2 bright) {
    if (mode == 0) return vec4(c.a, 0.0, 0.0, 1.0);
    if (mode == 1) return vec4(1.0 - c.a, 0.0, 0.0, 1.0);
    if (mode == 3) {   // soft threshold on luma of the straight colour; premultiplied result
        vec3 s = fxStraight(c);
        float l = fxLuma(s);
        float k = max(bright.y, 1e-4);
        float g = clamp((l - bright.x + k) / (2.0 * k), 0.0, 1.0);
        g = g * g * (3.0 - 2.0 * g);
        if (bright.y <= 1e-4) g = l >= bright.x ? 1.0 : 0.0;
        return c * g;
    }
    return c;
}

// D pass: block average of the field of the (shifted) input; `shift` = content offset in px (shadow)
vec4 fxDownBox(int mode, int L, ivec2 shift, vec2 bright) {
    ivec2 p = fxLvlPos(L);
    int d = 1 << L;
    ivec2 base = (p - 1) * d - fxLvlOff(L) - shift;
    vec4 acc = vec4(0.0);
    for (int j = 0; j < d; j++)
        for (int i = 0; i < d; i++) acc += fxFieldOf(mode, fxSrc(base + ivec2(i, j)), bright);
    return acc / float(d * d);
}

// H / V pass at level L (gaussian weights normalised over the taps; outside the logical area = `outside`).  Weights by recurrence
// w(i+1) = w(i) * d_i, d_i = d_(i-1) * c^2, c = exp(-1/(2 sigma^2)): two exp() per pass instead of one per tap (exactly exp(-i^2/(2 sigma^2))).
vec4 fxLowBlur(bool horiz, float sg, int R, int L, vec4 outside) {
    ivec2 p = fxLvlPos(L);
    ivec2 st = horiz ? ivec2(1, 0) : ivec2(0, 1);
    vec4 acc = fxLvlFetch(p, L, outside);
    float ws = 1.0;
    float c = sg > 1e-4 ? exp(-0.5 / (sg * sg)) : 0.0;
    float c2 = c * c;
    float d = c;
    float w = 1.0;
    for (int i = 1; i <= R; i++) {
        w *= d;
        d *= c2;
        acc += w * (fxLvlFetch(p + st * i, L, outside) + fxLvlFetch(p - st * i, L, outside));
        ws += 2.0 * w;
    }
    return acc / ws;
}

// U: bilinear value of the level-L texture at full-res pixel f
vec4 fxUp(ivec2 f, int L, vec4 outside) {
    int d = 1 << L;
    vec2 u = (vec2(f + fxLvlOff(L)) + 0.5) / float(d) + 0.5;
    vec2 fl = floor(u);
    ivec2 i0 = ivec2(int(fl.x), int(fl.y));
    vec2 w = u - fl;
    return mix(mix(fxLvlFetch(i0, L, outside), fxLvlFetch(i0 + ivec2(1, 0), L, outside), w.x),
               mix(fxLvlFetch(i0 + ivec2(0, 1), L, outside), fxLvlFetch(i0 + ivec2(1, 1), L, outside), w.x), w.y);
}
