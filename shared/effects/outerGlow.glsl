// Outer Glow, drawn BELOW the content.  2 passes (separable gaussian of the content alpha).
//   uP0 = (sigma, radius R px (kernel half width, <= 128), 0, 0)      uP1 = colour (straight rgb, a = alpha * opacity)
// glow strength g = min(1, 2 * blur(alpha)): 1.0 at a straight edge, falling to ~0 at distance R (the "size").
// pass 0: horizontal blur -> .r (f16).  pass 1: vertical blur, out = content over glow.
// Pyramid (size > 16 px): uP0 = (sigma_low, R_low, 0, 0), uP2.x = level L; passes 2 down(alpha) 3 H 4 V (level L), 5 up + composite.
void main() {
    ivec2 f = fxPos();
    int R = int(uP0.y + 0.5);
    float sg = uP0.x;
    float acc = 0.0, ws = 0.0;
    if (fxPass() >= 2) {
        int L = int(uP2.x + 0.5);
        int pid = fxPass();
        if (pid == 2) fxOut(fxDownBox(0, L, ivec2(0), vec2(0.0)));
        else if (pid == 3) fxOut(fxLowBlur(true, sg, R, L, vec4(0.0)));
        else if (pid == 4) fxOut(fxLowBlur(false, sg, R, L, vec4(0.0)));
        else {
            float g = min(1.0, 2.0 * clamp(fxUp(f, L, vec4(0.0)).r, 0.0, 1.0)) * clamp(uP1.a, 0.0, 1.0);
            vec4 c = fxSrc(f);
            fxOut(c + vec4(uP1.rgb * g, g) * (1.0 - c.a));
        }
        return;
    }
    if (fxPass() == 0) {
        for (int i = -R; i <= R; i++) {
            float w = fxGauss(float(i), sg);
            acc += w * fxSrc(f + ivec2(i, 0)).a;
            ws += w;
        }
        fxOut(vec4(acc / ws, 0.0, 0.0, 1.0));
    } else {
        for (int j = -R; j <= R; j++) {
            float w = fxGauss(float(j), sg);
            acc += w * fxAux(f + ivec2(0, j)).r;
            ws += w;
        }
        float g = min(1.0, 2.0 * acc / ws) * clamp(uP1.a, 0.0, 1.0);
        vec4 c = fxSrc(f);
        fxOut(c + vec4(uP1.rgb * g, g) * (1.0 - c.a));
    }
}
