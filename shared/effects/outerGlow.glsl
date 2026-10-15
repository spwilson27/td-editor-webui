// Outer Glow, drawn BELOW the content.  2 passes (separable gaussian of the content alpha).
//   uP0 = (sigma, radius R px (kernel half width, <= 128), 0, 0)      uP1 = colour (straight rgb, a = alpha * opacity)
// glow strength g = min(1, 2 * blur(alpha)): 1.0 at a straight edge, falling to ~0 at distance R (the "size").
// pass 0: horizontal blur -> .r (f16).  pass 1: vertical blur, out = content over glow.
void main() {
    ivec2 f = fxPos();
    int R = int(uP0.y + 0.5);
    float sg = uP0.x;
    float acc = 0.0, ws = 0.0;
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
