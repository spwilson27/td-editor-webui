// Inner Glow, drawn ON the content (clipped to its alpha).  2 passes (separable gaussian of 1 - alpha; the area outside
// the texture counts as transparent, i.e. the glow also hugs the canvas border).
//   uP0 = (sigma, radius R px (<= 128), 0, 0)      uP1 = colour (straight rgb, a = alpha * opacity)
// g = min(1, 2 * blur(1 - alpha)); out = C * (1 - g) + rgb * g * A.
// Pyramid (size > 16 px): uP0 = (sigma_low, R_low, 0, 0), uP2.x = level L; passes 2 down(1 - alpha) 3 H 4 V (level L), 5 up + composite.
void main() {
    ivec2 f = fxPos();
    int R = int(uP0.y + 0.5);
    float sg = uP0.x;
    float acc = 0.0, ws = 0.0;
    if (fxPass() >= 2) {
        int L = int(uP2.x + 0.5);
        int pid = fxPass();
        vec4 out1 = vec4(1.0, 0.0, 0.0, 1.0);
        if (pid == 2) fxOut(fxDownBox(1, L, ivec2(0), vec2(0.0)));
        else if (pid == 3) fxOut(fxLowBlur(true, sg, R, L, out1));
        else if (pid == 4) fxOut(fxLowBlur(false, sg, R, L, out1));
        else {
            float g = min(1.0, 2.0 * clamp(fxUp(f, L, out1).r, 0.0, 1.0)) * clamp(uP1.a, 0.0, 1.0);
            vec4 c = fxSrc(f);
            fxOut(vec4(c.rgb * (1.0 - g) + uP1.rgb * g * c.a, c.a));
        }
        return;
    }
    if (fxPass() == 0) {
        for (int i = -R; i <= R; i++) {
            float w = fxGauss(float(i), sg);
            acc += w * (1.0 - fxSrc(f + ivec2(i, 0)).a);
            ws += w;
        }
        fxOut(vec4(acc / ws, 0.0, 0.0, 1.0));
    } else {
        for (int j = -R; j <= R; j++) {
            float w = fxGauss(float(j), sg);
            ivec2 q = f + ivec2(0, j);
            acc += w * (fxIn(q, fxSize()) ? fxAux(q).r : 1.0);   // outside the texture counts as transparent: field 1 (the glow hugs all four borders)
            ws += w;
        }
        float g = min(1.0, 2.0 * acc / ws) * clamp(uP1.a, 0.0, 1.0);
        vec4 c = fxSrc(f);
        fxOut(vec4(c.rgb * (1.0 - g) + uP1.rgb * g * c.a, c.a));
    }
}
