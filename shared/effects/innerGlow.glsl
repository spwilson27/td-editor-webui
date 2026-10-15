// Inner Glow, drawn ON the content (clipped to its alpha).  2 passes (separable gaussian of 1 - alpha; the area outside
// the texture counts as transparent, i.e. the glow also hugs the canvas border).
//   uP0 = (sigma, radius R px (<= 128), 0, 0)      uP1 = colour (straight rgb, a = alpha * opacity)
// g = min(1, 2 * blur(1 - alpha)); out = C * (1 - g) + rgb * g * A.
void main() {
    ivec2 f = fxPos();
    int R = int(uP0.y + 0.5);
    float sg = uP0.x;
    float acc = 0.0, ws = 0.0;
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
            acc += w * fxAux(f + ivec2(0, j)).r;
            ws += w;
        }
        float g = min(1.0, 2.0 * acc / ws) * clamp(uP1.a, 0.0, 1.0);
        vec4 c = fxSrc(f);
        fxOut(vec4(c.rgb * (1.0 - g) + uP1.rgb * g * c.a, c.a));
    }
}
