// Drop Shadow, drawn BELOW the content.  2 passes (separable gaussian of the content alpha).
//   uP0 = (sigma, radius R in px (kernel half width, <= 128), dx, dy)  shadow offset in document px (y down, integers)
//   uP1 = colour (straight rgb, a = colour alpha * opacity)
// pass 0: horizontal blur of the (shifted) alpha, written to .r        (aux = f16)
// pass 1: vertical blur, shadow = colour * blurred alpha; out = content over shadow  = C + S * (1 - A)
void main() {
    ivec2 f = fxPos();
    int R = int(uP0.y + 0.5);
    float sg = uP0.x;
    ivec2 d = ivec2(int(uP0.z), int(uP0.w));
    if (fxPass() == 0) {
        float acc = 0.0, ws = 0.0;
        for (int i = -R; i <= R; i++) {
            float w = fxGauss(float(i), sg);
            acc += w * fxSrc(f + ivec2(i - d.x, -d.y)).a;
            ws += w;
        }
        fxOut(vec4(acc / ws, 0.0, 0.0, 1.0));
    } else {
        float acc = 0.0, ws = 0.0;
        for (int j = -R; j <= R; j++) {
            float w = fxGauss(float(j), sg);
            acc += w * fxAux(f + ivec2(0, j)).r;
            ws += w;
        }
        float sa = clamp(acc / ws, 0.0, 1.0) * clamp(uP1.a, 0.0, 1.0);
        vec4 c = fxSrc(f);
        fxOut(c + vec4(uP1.rgb * sa, sa) * (1.0 - c.a));
    }
}
