// Bevel (inner bevel / emboss).  2 passes.  The alpha is blurred (gaussian, sigma = R/3) into a smooth height field
// h and its gradient is computed with gaussian-DERIVATIVE kernels, separably:
//   pass 0 (horizontal):  .r = sum g(j) A(x+j)       .g = sum (j/sigma^2) g(j) A(x+j)       (f16)
//   pass 1 (vertical):    hx = sum g(j) G(y+j)       hy = sum (j/sigma^2) g(j) R(y+j)       (document axes, y down)
// lit = -(hx, hy) . L  where L = unit vector TOWARDS the light in document axes (uP1.xy; angle 0 = light from the right,
// counter-clockwise on screen, so 120 = upper left).  t = clamp(lit * sigma * 2.5 * depth, -1, 1).
// t > 0 mixes the highlight colour into the content, t < 0 the shadow colour; alpha is unchanged.
//   uP0 = (sigma, radius R px (<= 128), depth 0..1 (= depth% / 100), 0)
//   uP1 = (Lx, Ly, 0, 0)    uP2 = highlight (straight rgb, a)    uP3 = shadow (straight rgb, a)
// Pyramid (size > 16 px, blurlib.glsl): uP0 = (sigma_low, R_low, depth, L), uP1 = (Lx, Ly, sigma_full, 0); passes
//   2 down (alpha, level L)   3 H (as pass 0, low res)   4 V (as pass 1, low res: .r = hx_low, .g = hy_low, per LOW-RES px)
//   5 up: bilinear (hx, hy), gradient per full-res px = / 2^L, then the same lighting as pass 1 with sigma_full.
void main() {
    ivec2 f = fxPos();
    int R = int(uP0.y + 0.5);
    float sg = max(uP0.x, 1e-3);
    float is2 = 1.0 / (sg * sg);
    if (fxPass() >= 2) {
        int L = int(uP0.w + 0.5);
        int pid = fxPass();
        vec4 z = vec4(0.0);
        if (pid == 2) { fxOut(fxDownBox(0, L, ivec2(0), vec2(0.0))); return; }
        ivec2 p = fxLvlPos(L);
        if (pid == 3) {
            float a0 = 0.0, a1 = 0.0, ws = 0.0;
            for (int j = -R; j <= R; j++) {
                float w = fxGauss(float(j), sg);
                float a = fxLvlFetch(p + ivec2(j, 0), L, z).r;
                a0 += w * a;
                a1 += w * float(j) * is2 * a;
                ws += w;
            }
            fxOut(vec4(a0 / ws, a1 / ws, 0.0, 1.0));
            return;
        }
        if (pid == 4) {
            float hx = 0.0, hy = 0.0, ws = 0.0;
            for (int j = -R; j <= R; j++) {
                float w = fxGauss(float(j), sg);
                vec4 s = fxLvlFetch(p + ivec2(0, j), L, z);
                hx += w * s.g;
                hy += w * float(j) * is2 * s.r;
                ws += w;
            }
            fxOut(vec4(hx / ws, hy / ws, 0.0, 1.0));
            return;
        }
        vec4 g = fxUp(f, L, z);
        float lit = -(g.r * uP1.x + g.g * uP1.y) / float(1 << L);
        float t = clamp(lit * uP1.z * 2.5 * uP0.z, -1.0, 1.0);
        float tp = max(t, 0.0) * clamp(uP2.a, 0.0, 1.0);
        float tn = max(-t, 0.0) * clamp(uP3.a, 0.0, 1.0);
        vec4 c = fxSrc(f);
        fxOut(vec4(c.rgb * (1.0 - tp - tn) + c.a * (uP2.rgb * tp + uP3.rgb * tn), c.a));
        return;
    }
    if (fxPass() == 0) {
        float a0 = 0.0, a1 = 0.0, ws = 0.0;
        for (int j = -R; j <= R; j++) {
            float w = fxGauss(float(j), sg);
            float a = fxSrc(f + ivec2(j, 0)).a;
            a0 += w * a;
            a1 += w * float(j) * is2 * a;
            ws += w;
        }
        fxOut(vec4(a0 / ws, a1 / ws, 0.0, 1.0));
    } else {
        float hx = 0.0, hy = 0.0, ws = 0.0;
        for (int j = -R; j <= R; j++) {
            float w = fxGauss(float(j), sg);
            vec4 s = fxAux(f + ivec2(0, j));
            hx += w * s.g;
            hy += w * float(j) * is2 * s.r;
            ws += w;
        }
        hx /= ws;
        hy /= ws;
        float lit = -(hx * uP1.x + hy * uP1.y);
        float t = clamp(lit * sg * 2.5 * uP0.z, -1.0, 1.0);
        float tp = max(t, 0.0) * clamp(uP2.a, 0.0, 1.0);
        float tn = max(-t, 0.0) * clamp(uP3.a, 0.0, 1.0);
        vec4 c = fxSrc(f);
        fxOut(vec4(c.rgb * (1.0 - tp - tn) + c.a * (uP2.rgb * tp + uP3.rgb * tn), c.a));
    }
}
