// Pixel Sort (experimental).  3 passes, exact for spans up to MAXSPAN pixels, no iteration count to tune.
// A span is a maximal run of consecutive pixels along the sort axis (rows for 'h', columns for 'v') that have alpha > 0 and a
// sort key inside [low, high].  Each span is sorted ascending by key (stable: ties keep their order) along +x (h) or +y (v).
// Spans are cut at multiples of MAXSPAN (256) in document coordinates, so a longer run is sorted in aligned chunks of <= 256 px.
// Why not odd-even transposition / bitonic: those need N passes (= N GLSL TOP nodes in TouchDesigner's non-feedback chain) for N
// elements; the rank method below is 3 passes whatever the span length.  Cost per pixel: O(span length) texel fetches in
// pass 1 (scan + rank) and pass 2 (gather); fully-sorted worst case 256 px spans ~ 700 fetches/pixel (see perf notes).
//   key: luma (Rec.709 of the straight colour) or hue, quantised to 1/4095 so GPU rounding differences cannot reorder ties.
//   uP0 = (axis 0 = h / 1 = v, low, high, key 0 luma / 1 hue)
// pass 0: aux = (key, member flag)                        (rgba32f; key quantised to 12 bits)
// pass 1: aux = (span start t0, span end t1, rank within span, member)    positions along the axis, region-local
// pass 2: out(t) = input pixel whose rank == t - t0 within the span of t; non-members pass through.
const int MAXSPAN = 256;

ivec2 lanePos(ivec2 f, int axis) { return axis == 0 ? f : ivec2(f.y, f.x); }   // (t along axis, lane)
ivec2 fromLane(int t, int lane, int axis) { return axis == 0 ? ivec2(t, lane) : ivec2(lane, t); }

void main() {
    ivec2 f = fxPos();
    int axis = int(uP0.x + 0.5);
    int pass_ = fxPass();
    if (pass_ == 0) {
        vec4 c = fxSrc(f);
        vec3 s = fxStraight(c);
        float key = (uP0.w > 0.5) ? fxHue(s) : fxLuma(s);
        key = floor(key * 4095.0 + 0.5) / 4095.0;
        float member = (c.a > 0.0 && key >= uP0.y && key <= uP0.z) ? 1.0 : 0.0;
        fxOut(vec4(key, member, 0.0, 1.0));
        return;
    }
    ivec2 lp = lanePos(f, axis);
    int t = lp.x;
    int lane = lp.y;
    ivec2 sz = fxSize();
    int len = axis == 0 ? sz.x : sz.y;
    int org = axis == 0 ? int(uPass.y + 0.5) : int(uPass.z + 0.5);
    // aligned chunk (document coordinates) clipped to the region
    int tdoc = t + org;
    int cs = (tdoc / MAXSPAN) * MAXSPAN - org;
    int ce = cs + MAXSPAN - 1;
    cs = max(cs, 0);
    ce = min(ce, len - 1);
    if (pass_ == 1) {
        vec4 me = fxAux(f);
        if (me.g < 0.5) { fxOut(vec4(0.0, 0.0, 0.0, 0.0)); return; }
        int t0 = t, t1 = t;
        for (int i = 0; i < MAXSPAN; i++) {
            if (t0 <= cs || fxAux(fromLane(t0 - 1, lane, axis)).g < 0.5) break;
            t0--;
        }
        for (int i = 0; i < MAXSPAN; i++) {
            if (t1 >= ce || fxAux(fromLane(t1 + 1, lane, axis)).g < 0.5) break;
            t1++;
        }
        int rank = 0;
        for (int j = t0; j <= t1; j++) {
            float kj = fxAux(fromLane(j, lane, axis)).r;
            if (kj < me.r || (kj == me.r && j < t)) rank++;
        }
        fxOut(vec4(float(t0), float(t1), float(rank), 1.0));
    } else {
        vec4 me = fxAux(f);
        if (me.w < 0.5) { fxOut(fxSrc(f)); return; }
        int t0 = int(me.x + 0.5);
        int t1 = int(me.y + 0.5);
        int want = t - t0;
        vec4 res = fxSrc(f);
        for (int j = t0; j <= t1; j++) {
            if (int(fxAux(fromLane(j, lane, axis)).z + 0.5) == want) {
                res = fxSrc(fromLane(j, lane, axis));
                break;
            }
        }
        fxOut(res);
    }
}
