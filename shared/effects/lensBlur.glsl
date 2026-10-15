// Lens blur (bokeh).  uP0 = (spiral radius Rl in texels of the spiral's level, taps N, blades (0 = circle), rotation rad)
//                     uP1 = (highlight gain k = 15 * brightness/100, threshold, level L, seed)
// L = 0: pass 0 = spiral at full resolution on the input (reads input 0) -> final rgba.
// L > 0: pass 1 = box down-sample of the boosted field (level L), pass 2 = spiral at level L (reads input 1), pass 3 = bilinear up-sample + clamp.
// Field: (rgb premultiplied * gain, alpha) -- rgb may exceed alpha in the intermediate (f16) textures; the last pass clamps rgb to [0, alpha].
float lbGain(vec4 c) {
    if (uP1.x <= 0.0) return 1.0;
    float l = fxLuma(fxStraight(c));
    float h = clamp((l - uP1.y) / max(1.0 - uP1.y, 1e-3), 0.0, 1.0);
    return 1.0 + uP1.x * h;
}
vec4 lbField(vec4 c) { return vec4(c.rgb * lbGain(c), c.a); }

vec4 lbSrcLinear(vec2 q) {
    vec2 t = q - 0.5;
    vec2 fl = floor(t);
    ivec2 i = ivec2(int(fl.x), int(fl.y));
    vec2 w = t - fl;
    return mix(mix(lbField(fxSrc(i)), lbField(fxSrc(i + ivec2(1, 0))), w.x),
               mix(lbField(fxSrc(i + ivec2(0, 1))), lbField(fxSrc(i + ivec2(1, 1))), w.x), w.y);
}
vec4 lbLvlLinear(vec2 q, int L) {
    vec2 t = q - 0.5;
    vec2 fl = floor(t);
    ivec2 i = ivec2(int(fl.x), int(fl.y));
    vec2 w = t - fl;
    vec4 z = vec4(0.0);
    return mix(mix(fxLvlFetch(i, L, z), fxLvlFetch(i + ivec2(1, 0), L, z), w.x),
               mix(fxLvlFetch(i + ivec2(0, 1), L, z), fxLvlFetch(i + ivec2(1, 1), L, z), w.x), w.y);
}

vec4 lbSpiral(vec2 c, ivec2 hashPos, int L) {
    float R = uP0.x;
    int n = int(uP0.y + 0.5);
    int bl = int(uP0.z + 0.5);
    uint seed = uint(uP1.w + 0.5);
    float jit = 6.28318530718 * fxRand2(hashPos, seed);
    float sector = bl > 0 ? 6.28318530718 / float(bl) : 1.0;
    float cb = bl > 0 ? fxCos(3.14159265359 / float(bl)) : 1.0;
    vec4 acc = vec4(0.0);
    float ws = 0.0;
    for (int i = 0; i < 64; i++) {
        if (i >= n) break;
        float rho = sqrt((float(i) + 0.5) / float(n));
        float th = float(i) * 2.39996322973;
        float w = 1.0;
        if (bl > 0) {
            float a = mod(th - uP0.w, sector) - 0.5 * sector;
            float re = cb / fxCos(a);
            rho *= re;
            w = re * re;
        }
        float ang = th + jit;
        vec2 q = c + R * rho * vec2(fxCos(ang), fxSin(ang));
        vec4 s = L == 0 ? lbSrcLinear(q) : lbLvlLinear(q, L);
        acc += w * s;
        ws += w;
    }
    return acc / ws;
}

vec4 lbFinish(vec4 c) { return vec4(clamp(c.rgb, 0.0, c.a), c.a); }

void main() {
    int pid = fxPass();
    int L = int(uP1.z + 0.5);
    if (pid == 0) {
        ivec2 f = fxPos();
        fxOut(lbFinish(lbSpiral(vec2(f) + 0.5, fxDoc(f), 0)));
        return;
    }
    if (pid == 1) {
        ivec2 p = fxLvlPos(L);
        int d = 1 << L;
        ivec2 base = (p - 1) * d - fxLvlOff(L);
        vec4 acc = vec4(0.0);
        for (int j = 0; j < d; j++)
            for (int i = 0; i < d; i++) acc += lbField(fxSrc(base + ivec2(i, j)));
        fxOut(acc / float(d * d));
        return;
    }
    if (pid == 2) {
        ivec2 p = fxLvlPos(L);
        int d = 1 << L;
        ivec2 g = p - 1 + ivec2(int(floor((uPass.y + 0.5) / float(d))), int(floor((uPass.z + 0.5) / float(d))));
        fxOut(lbSpiral(vec2(p) + 0.5, g, L));
        return;
    }
    fxOut(lbFinish(fxUp(fxPos(), L, vec4(0.0))));
}
