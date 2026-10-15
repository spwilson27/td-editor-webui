// Motion blur (filter "motionBlur"): box blur along a direction, 1 or 2 passes.
//   uP0 = (dir.x, dir.y, a, n)   dir in fx coordinates (y down), a = box width of pass 0 / comb spacing of pass 1, n = taps (pass 0: n1, pass 1: comb count)
// pass 0 (reads input 0): n bilinear taps spanning [-a/2, a/2] (centred, equal weights).
// pass 1 (reads input 1): n taps at (j - (n-1)/2) * a, equal weights.  Pass 0 alone is the whole filter when length <= 32.
vec4 mbFetch(vec2 q, bool second) {
    vec2 t = q - 0.5;
    vec2 fl = floor(t);
    ivec2 i = ivec2(int(fl.x), int(fl.y));
    vec2 w = t - fl;
    if (second)
        return mix(mix(fxAux(i), fxAux(i + ivec2(1, 0)), w.x), mix(fxAux(i + ivec2(0, 1)), fxAux(i + ivec2(1, 1)), w.x), w.y);
    return fxSrcLinear(q);
}

void main() {
    ivec2 f = fxPos();
    vec2 c = vec2(f) + 0.5;
    vec2 d = uP0.xy;
    float a = uP0.z;
    int n = int(uP0.w + 0.5);
    bool second = fxPass() == 1;
    vec4 acc = vec4(0.0);
    for (int i = 0; i < 48; i++) {
        if (i >= n) break;
        float o = second ? (float(i) - 0.5 * float(n - 1)) * a : ((float(i) + 0.5) / float(n) - 0.5) * a;
        acc += mbFetch(c + d * o, second);
    }
    fxOut(acc / float(n));
}
