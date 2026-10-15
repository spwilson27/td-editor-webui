// Raster Editor v2 layer blend (docs/DESIGN_V2.md 4.1).
// GLSL TOP pixel shader.  Inputs: 0 = below (accumulated, premultiplied), 1 = source (layer
// surface / adjusted result, premultiplied), 2 = mask (optional, .r).
// Uniforms (GLSL TOP "Vectors" page):
//   uParams  vec4  x = uMode (BlendMode index, web/src/engine/types.ts: normal=0 ... luminosity=15)
//                  y = uOpacity (0..1)   z = uHasMask (0/1)   w = uAdjust (0, 1, 7, 8)
//   uXform   vec4  layer -> document mapping  doc = (x, y) + (sx, sy) * layer  (document pixels, top-left
//                  origin, x/y fractional, sx/sy > 0).  Layer pixel (0,0) is the top-left texel of the source
//                  (its size = textureSize of the source input).
// uAdjust = 7: RESAMPLE pass (exists for layers whose transform is not an integer offset at scale 1, and for
//   layers with effects / a mask that must be applied before the effects: then it is the identity / integer case).
//   Inputs: 0 = layer surface, 1 = mask surface (or the surface again when uHasMask = 0).  Output (document
//   sized, custom resolution) = source * coverage * mask, premultiplied, in document space.  The mask covers the
//   same layer rect (normalised coordinates).
//   AFFINE (v5): layer -> document  doc = T(x,y) . R(rot) . K(kx,ky) . S(sx,sy) . layer  (rot clockwise on screen,
//   K = [[1, tan kx],[tan ky, 1]], about the surface's top-left, document top-left origin / y down).  In this pass
//   uXform = (m00, m01, m10, m11) is the INVERSE of the linear part (document offset -> layer pixels) and
//   uA.xy = (x, y), so  layer = M * (docPixelCentre - uA.xy).
//   Coverage = area of (the document pixel's footprint, a parallelogram in layer space, clipped to the source rect
//   by Sutherland-Hodgman) / footprint area: fractional on the rotated / skewed edges.  Sampling: linear at the pixel
//   centre; trilinear mip level lod = max(0, -log2(sqrt(|det A|)) - 0.5) with A the forward linear part (the
//   geometric mean of the singular values = Skia's area-scale rule; for pure scale = -0.5 log2(sx*sy) - 0.5, what
//   Canvas 2D drawImage imageSmoothingQuality 'medium' does); the network sets this node's "Input Smoothness" to
//   mipmap while lod > 0 and linear otherwise, input extend = hold.
//   Only this pass ever reads through a mipmap filter; the blend passes below use texelFetch only.
// uAdjust = 8: MERGED pass (v6; GLSL *Multi* TOP, any number of inputs): composites up to 8 layers over input 0 in ONE
//   full-frame pass.  Inputs: 0 = below, 1..K = the sources of the K layers (bottom -> top), K+1.. = the masks of the
//   masked layers.  Layer slot i (uniform uL<i>, i < 8; unused slots are all zero => opacity 0 => skipped):
//     uL<i>.x = mode + 16 * maskInputIndex   (maskInputIndex 9..15, 0 = no mask)      uL<i>.y = opacity
//     uL<i>.zw = integer document offset of the source (same placement rule as the single pass)
//   The accumulator stays in float32 registers between the layers (more exact than K chained 16-bit passes); each
//   layer reads only the texels inside its own rect (the bounding-box skip).  Pixel-for-pixel the result equals K
//   chained uAdjust 0 passes within the rounding of the intermediate format.
// uAdjust 0 / 1 (blend / mix passes): inputs 0 = below, 1 = source, 2 = mask.  The source is at document
//   size (a resample result, group result, adjustment source) or a surface placed by an INTEGER offset:
//   source texel = document pixel - round(uXform.xy)  (outside the source, or outside the mask = transparent / 0).
// uAdjust = 0: W3C Compositing and Blending L1 "source-over with blend mode" (== Canvas 2D
//   globalCompositeOperation + globalAlpha), premultiplied in / out.
// uAdjust = 1: out = mix(below, adjusted, opacity * mask)   (adjusted = premultiplied RGBA, input 1).
// (v8: the classic adjustments -- levels, brightness / contrast, hue / saturation, invert, threshold, blur -- are effect types
//  (shared/effects/*.glsl) run by an effect chain; an adjustment layer's blend pass is a plain uAdjust 1 mix.)

uniform vec4 uParams;
uniform vec4 uXform;
uniform vec4 uA;      // resample translation (uAdjust 7)
uniform vec4 uL0;     // merged pass layer slots (uAdjust 8)
uniform vec4 uL1;
uniform vec4 uL2;
uniform vec4 uL3;
uniform vec4 uL4;
uniform vec4 uL5;
uniform vec4 uL6;
uniform vec4 uL7;

out vec4 fragColor;

float lum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }

vec3 clipColor(vec3 c) {
    float l = lum(c);
    float n = min(min(c.r, c.g), c.b);
    float x = max(max(c.r, c.g), c.b);
    if (n < 0.0) c = l + (c - l) * l / (l - n);
    if (x > 1.0) c = l + (c - l) * (1.0 - l) / (x - l);
    return c;
}

vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lum(c))); }

float satOf(vec3 c) { return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }

vec3 setSat(vec3 c, float s) {
    float mn = min(min(c.r, c.g), c.b);
    float mx = max(max(c.r, c.g), c.b);
    if (mx > mn) return (c - mn) * s / (mx - mn);
    return vec3(0.0);
}

float hardLight1(float cb, float cs) {
    return cs <= 0.5 ? cb * (2.0 * cs) : (cb + (2.0 * cs - 1.0) - cb * (2.0 * cs - 1.0));
}

float softLight1(float cb, float cs) {
    if (cs <= 0.5) return cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb);
    float d = cb <= 0.25 ? ((16.0 * cb - 12.0) * cb + 4.0) * cb : sqrt(cb);
    return cb + (2.0 * cs - 1.0) * (d - cb);
}

// The comparisons use a tolerance of 0.0005 (< 1/255 / 7): un-premultiplying 16-bit values can land
// 1-2 LSB off the exact 0 / 1 that the 8-bit canvas sees, and these branches are discontinuous.
float dodge1(float cb, float cs) {
    if (cb <= 0.0005) return 0.0;
    if (cs >= 0.9995) return 1.0;
    return min(1.0, cb / (1.0 - cs));
}

float burn1(float cb, float cs) {
    if (cb >= 0.9995) return 1.0;
    if (cs <= 0.0005) return 0.0;
    return 1.0 - min(1.0, (1.0 - cb) / cs);
}

vec3 blendFn(int mode, vec3 cb, vec3 cs) {
    switch (mode) {
    case 0: return cs;
    case 1: return cb * cs;
    case 2: return cb + cs - cb * cs;
    case 3: return vec3(hardLight1(cs.r, cb.r), hardLight1(cs.g, cb.g), hardLight1(cs.b, cb.b));
    case 4: return vec3(softLight1(cb.r, cs.r), softLight1(cb.g, cs.g), softLight1(cb.b, cs.b));
    case 5: return vec3(hardLight1(cb.r, cs.r), hardLight1(cb.g, cs.g), hardLight1(cb.b, cs.b));
    case 6: return min(cb, cs);
    case 7: return max(cb, cs);
    case 8: return vec3(dodge1(cb.r, cs.r), dodge1(cb.g, cs.g), dodge1(cb.b, cs.b));
    case 9: return vec3(burn1(cb.r, cs.r), burn1(cb.g, cs.g), burn1(cb.b, cs.b));
    case 10: return abs(cb - cs);
    case 11: return cb + cs - 2.0 * cb * cs;
    case 12: return setLum(setSat(cs, satOf(cb)), lum(cb));          // hue
    case 13: return setLum(setSat(cb, satOf(cs)), lum(cb));          // saturation
    case 14: return setLum(cs, lum(cb));                             // color
    case 15: return setLum(cb, lum(cs));                             // luminosity
    }
    return cs;
}

// Clips the convex polygon p[0..n) to the half plane dot(v, nrm) >= d (Sutherland-Hodgman); returns the new count (<= 8).
int clipPoly(inout vec2 p[8], int n, vec2 nrm, float d) {
    vec2 q[8];
    for (int i = 0; i < 8; i++) q[i] = vec2(0.0);
    int m = 0;
    for (int i = 0; i < 8; i++) {
        if (i >= n) break;
        vec2 a = p[i];
        vec2 b = p[(i + 1) % n];
        float da = dot(a, nrm) - d;
        float db = dot(b, nrm) - d;
        if (da >= 0.0 && m < 8) q[m++] = a;
        if ((da >= 0.0) != (db >= 0.0) && m < 8) q[m++] = a + (b - a) * (da / (da - db));
    }
    for (int i = 0; i < 8; i++) p[i] = q[i];
    return m;
}

// Fraction of the pixel footprint (the unit document pixel at c, mapped into layer pixels = a parallelogram with
// centre l and half edges e0, e1) that lies inside the source rect [0, srcSz].
float footprintCoverage(vec2 l, vec2 e0, vec2 e1, vec2 srcSz) {
    vec2 ext = abs(e0) + abs(e1);
    vec2 lo = l - ext, hi = l + ext;                       // bounding box of the footprint
    if (hi.x <= 0.0 || hi.y <= 0.0 || lo.x >= srcSz.x || lo.y >= srcSz.y) return 0.0;
    float area0 = abs(e0.x * e1.y - e0.y * e1.x) * 4.0;
    if (area0 <= 1e-12) return 0.0;
    if (e0.y == 0.0 && e1.x == 0.0) {                      // axis aligned: product of the 1-D overlaps
        vec2 cv = clamp((min(l + ext, srcSz) - max(l - ext, vec2(0.0))) / (2.0 * ext), 0.0, 1.0);
        return cv.x * cv.y;
    }
    if (lo.x >= 0.0 && lo.y >= 0.0 && hi.x <= srcSz.x && hi.y <= srcSz.y) return 1.0;
    vec2 p[8];
    p[0] = l - e0 - e1; p[1] = l + e0 - e1; p[2] = l + e0 + e1; p[3] = l - e0 + e1;
    p[4] = p[5] = p[6] = p[7] = vec2(0.0);
    int n = 4;
    n = clipPoly(p, n, vec2(1.0, 0.0), 0.0);
    n = clipPoly(p, n, vec2(-1.0, 0.0), -srcSz.x);
    n = clipPoly(p, n, vec2(0.0, 1.0), 0.0);
    n = clipPoly(p, n, vec2(0.0, -1.0), -srcSz.y);
    float a2 = 0.0;
    for (int i = 0; i < 8; i++) {
        if (i >= n) break;
        vec2 a = p[i], b = p[(i + 1) % n];
        a2 += a.x * b.y - b.x * a.y;
    }
    return clamp(abs(a2) * 0.5 / area0, 0.0, 1.0);
}

// document pixel centre (top-left origin, continuous) -> layer pixels; samples source (input 0) and mask (input 1).
// uXform = (m00, m01, m10, m11): the INVERSE linear map (document -> layer pixels), uA.xy = the layer's translation
// (x, y) in document pixels:  l = M * (c - uA.xy).
void resample() {
    vec2 outSize = uTDOutputInfo.res.zw;
    vec2 srcSz = vec2(textureSize(sTD2DInputs[0], 0));
    vec2 c = vec2(gl_FragCoord.x, outSize.y - gl_FragCoord.y);
    vec2 d = c - uA.xy;
    vec2 l = vec2(uXform.x * d.x + uXform.y * d.y, uXform.z * d.x + uXform.w * d.y);
    vec2 e0 = 0.5 * vec2(uXform.x, uXform.z);            // footprint half edges in layer pixels (document x / y)
    vec2 e1 = 0.5 * vec2(uXform.y, uXform.w);
    float cov = footprintCoverage(l, e0, e1, srcSz);
    vec4 src = vec4(0.0);
    if (cov > 0.0) {
        bool exact = abs(uXform.x - 1.0) < 1e-6 && abs(uXform.w - 1.0) < 1e-6 && abs(uXform.y) < 1e-6 && abs(uXform.z) < 1e-6
            && abs(uA.x - floor(uA.x + 0.5)) < 1e-4 && abs(uA.y - floor(uA.y + 0.5)) < 1e-4;
        vec2 uv = vec2(l.x / srcSz.x, 1.0 - l.y / srcSz.y);
        float det = abs(uXform.x * uXform.w - uXform.y * uXform.z);
        float lod = max(0.0, 0.5 * log2(max(det, 1e-12)) - 0.5);       // sqrt(|det M|) layer px per document px
        ivec2 ip = ivec2(floor(l));
        float m = 1.0;
        if (exact) {
            src = texelFetch(sTD2DInputs[0], clamp(ivec2(ip.x, int(srcSz.y) - 1 - ip.y), ivec2(0), ivec2(srcSz) - 1), 0);
        } else {
            src = textureLod(sTD2DInputs[0], uv, lod);
        }
        if (uParams.z > 0.5) {
            ivec2 mSize = textureSize(sTD2DInputs[1], 0);
            if (exact && mSize == ivec2(srcSz)) {
                m = texelFetch(sTD2DInputs[1], clamp(ivec2(ip.x, mSize.y - 1 - ip.y), ivec2(0), mSize - 1), 0).r;
            } else {
                m = textureLod(sTD2DInputs[1], uv, lod).r;
            }
        }
        src *= cov * m;
    }
    fragColor = TDOutputSwizzle(src);
}

// W3C source-over with blend mode, premultiplied in / out.  src is NOT yet scaled by opacity * mask.
vec4 composeOver(vec4 below, vec4 src, int mode, float opacity, float m) {
    src *= opacity * m;                       // premultiplied: scales colour and alpha
    float as = src.a, ab = below.a;
    if (mode == 0) {
        // Normal: the general formula below reduces to  src + (1 - as) below  for premultiplied input (as * ab * clamp(cs)
        // = ab * min(src.rgb, as)); no divisions, no blend switch (the dominant case of a merged pass)
        vec4 r;
        r.rgb = (1.0 - ab) * src.rgb + (1.0 - as) * below.rgb + ab * min(src.rgb, vec3(as));
        r.a = as + ab - as * ab;
        return r;
    }
    vec3 cs = as > 0.0 ? src.rgb / as : vec3(0.0);
    vec3 cb = ab > 0.0 ? below.rgb / ab : vec3(0.0);
    vec3 bl = (as > 0.0 && ab > 0.0) ? clamp(blendFn(mode, clamp(cb, 0.0, 1.0), clamp(cs, 0.0, 1.0)), 0.0, 1.0) : vec3(0.0);
    vec4 res;
    res.rgb = (1.0 - ab) * src.rgb + (1.0 - as) * below.rgb + as * ab * bl;
    res.a = as + ab - as * ab;
    return res;
}

vec4 slotParams(int i) {
    if (i == 0) return uL0;
    if (i == 1) return uL1;
    if (i == 2) return uL2;
    if (i == 3) return uL3;
    if (i == 4) return uL4;
    if (i == 5) return uL5;
    if (i == 6) return uL6;
    return uL7;
}

void merged() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec4 acc = texelFetch(sTD2DInputs[0], p, 0);
    ivec2 outSize = textureSize(sTD2DInputs[0], 0);
    ivec2 pd = ivec2(p.x, outSize.y - 1 - p.y);
    for (int i = 0; i < 8; i++) {
        vec4 u = slotParams(i);
        if (u.y <= 0.0) continue;
        ivec2 d = pd - ivec2(floor(u.zw + 0.5));
        ivec2 msz = textureSize(sTD2DInputs[1 + i], 0);
        if (d.x < 0 || d.y < 0 || d.x >= msz.x || d.y >= msz.y) continue;      // outside this layer's rect
        int code = int(u.x + 0.5);
        int mi = code >> 4;
        int mode = code & 15;
        vec4 src = texelFetch(sTD2DInputs[1 + i], ivec2(d.x, msz.y - 1 - d.y), 0);
        if (src.a <= 0.0) continue;                      // transparent texel: every mode leaves the accumulator unchanged
        float m = 1.0;
        if (mi > 0) {
            ivec2 mSize = textureSize(sTD2DInputs[mi], 0);
            m = (d.x < mSize.x && d.y < mSize.y) ? texelFetch(sTD2DInputs[mi], ivec2(d.x, mSize.y - 1 - d.y), 0).r : 0.0;
        }
        acc = composeOver(acc, src, mode, clamp(u.y, 0.0, 1.0), m);
    }
    fragColor = TDOutputSwizzle(acc);
}

void main() {
    if (uParams.w > 7.5) { merged(); return; }
    if (uParams.w > 6.5) { resample(); return; }
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec4 below = texelFetch(sTD2DInputs[0], p, 0);
    int mode = int(uParams.x + 0.5);
    float opacity = clamp(uParams.y, 0.0, 1.0);

    // document (top-left) pixel -> source texel (bottom-left), integer offset only
    ivec2 outSize = textureSize(sTD2DInputs[0], 0);
    ivec2 srcSize = textureSize(sTD2DInputs[1], 0);
    ivec2 d = ivec2(p.x, outSize.y - 1 - p.y) - ivec2(floor(uXform.xy + 0.5));
    vec4 src = vec4(0.0);
    float m = 1.0;
    if (d.x >= 0 && d.y >= 0 && d.x < srcSize.x && d.y < srcSize.y) {
        ivec2 sp = ivec2(d.x, srcSize.y - 1 - d.y);
        src = texelFetch(sTD2DInputs[1], sp, 0);
        if (uParams.z > 0.5) {
            ivec2 mSize = textureSize(sTD2DInputs[2], 0);
            ivec2 mp = ivec2(d.x, mSize.y - 1 - d.y);
            m = (d.x < mSize.x && d.y < mSize.y) ? texelFetch(sTD2DInputs[2], mp, 0).r : 0.0;
        }
    }

    vec4 res;
    if (uParams.w > 0.5) {
        res = mix(below, src, opacity * m);
    } else {
        res = composeOver(below, src, mode, opacity, m);
    }
    fragColor = TDOutputSwizzle(res);
}
