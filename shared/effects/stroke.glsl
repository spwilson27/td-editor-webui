// Stroke (inside / centre / outside).  N + 1 passes: a jump-flood (JFA+1) nearest-edge-pixel search, then a composite.
// JFA is used instead of a blur because the stroke needs the Euclidean distance to the alpha edge, exact for any width,
// at O(passes) = ceil(log2(width)) + 2 full-screen passes independent of the width (a disc max filter would cost
// O(width^2) taps per pixel).  Seeds are the BOUNDARY pixels of the alpha >= 0.5 mask (a pixel on one side that has a
// 4-neighbour on the other side; outside the texture counts as transparent).  Each seed carries its signed distance
// `off` from its centre to the iso-0.5 contour estimated from its coverage (0.5 - alpha, so a hard edge gives +-0.5),
// which gives sub-pixel accurate anti-aliased stroke edges:
//     signed distance of a pixel p (positive outside)  sd = |p - s| + off_s   (outside p)   /   -(|p - s| - off_s)  (inside p)
// Pass ids: 0 = jump pass, 1 = composite.
//   jump pass:   uP0 = (step k px, first (1: seeds are derived from the effect input; 0: from the previous pass), 0, 0)
//                output (seed x, seed y, off, valid)  in fx coordinates, rgba32f.   Searches the 3x3 neighbourhood at +-k.
//   composite:   uP0 = (position 0 inside / 1 centre / 2 outside, width w px, 0, 0)    uP1 = colour (straight rgb, a = alpha * opacity)
//                The band is anti-aliased with clamp(0.5 - distance) at both edges and is composited OVER the content.
// Limits: width <= 128; JFA is approximate (rare off-by-a-pixel nearest seed); both hosts run the same code so they agree.
bool isEdge(ivec2 q) {
    bool inside = fxSrc(q).a >= 0.5;
    return (fxSrc(q + ivec2(1, 0)).a >= 0.5) != inside || (fxSrc(q + ivec2(-1, 0)).a >= 0.5) != inside
        || (fxSrc(q + ivec2(0, 1)).a >= 0.5) != inside || (fxSrc(q + ivec2(0, -1)).a >= 0.5) != inside;
}

vec4 seedAt(ivec2 q, bool first) {
    if (first) {
        if (!isEdge(q)) return vec4(0.0);
        float a = fxSrc(q).a;
        return vec4(float(q.x), float(q.y), clamp(0.5 - a, -0.5, 0.5), 1.0);
    }
    return fxAux(q);
}

void main() {
    ivec2 f = fxPos();
    if (fxPass() == 0) {
        int k = int(uP0.x + 0.5);
        bool first = uP0.y > 0.5;
        vec4 best = vec4(0.0);
        float bd = 1e30;
        for (int j = -1; j <= 1; j++) {
            for (int i = -1; i <= 1; i++) {
                vec4 s = seedAt(f + ivec2(i * k, j * k), first);
                if (s.w > 0.5) {
                    vec2 dv = s.xy - vec2(f);
                    float d = dot(dv, dv);
                    if (d < bd) { bd = d; best = s; }
                }
            }
        }
        fxOut(best);
    } else {
        vec4 c = fxSrc(f);
        vec4 s = fxAux(f);
        int pos = int(uP0.x + 0.5);
        float w = uP0.y;
        float sd = (c.a >= 0.5) ? -1e4 : 1e4;
        if (s.w > 0.5) {
            float dist = length(s.xy - vec2(f));
            sd = (c.a >= 0.5) ? -(dist - s.z) : (dist + s.z);
        }
        float cov;
        if (pos == 2) cov = min(clamp(sd + 0.5, 0.0, 1.0), clamp(w + 0.5 - sd, 0.0, 1.0));
        else if (pos == 0) cov = min(clamp(0.5 - sd, 0.0, 1.0), clamp(w + 0.5 + sd, 0.0, 1.0));
        else cov = clamp(0.5 * w + 0.5 - abs(sd), 0.0, 1.0);
        float sa = cov * clamp(uP1.a, 0.0, 1.0);
        fxOut(vec4(uP1.rgb * sa, sa) + c * (1.0 - sa));
    }
}
