// Vibrance / saturation.  uP0 = (vibrance -1..1, saturation -1..1, 0, 0).
// G = Rec.709 luma, S = HSV saturation; f = fv * (1 + sat); out = clamp(G + (c - G) * f).
//   v >= 0: fv = 1 + v * (1 - S)      v < 0: fv = 1 + v * S
void main() {
    vec4 c = fxSrc(fxPos());
    vec3 s = fxStraight(c);
    float mx = max(max(s.r, s.g), s.b);
    float mn = min(min(s.r, s.g), s.b);
    float sat = mx > 1e-6 ? (mx - mn) / mx : 0.0;
    float v = uP0.x;
    float fv = v >= 0.0 ? 1.0 + v * (1.0 - sat) : 1.0 + v * sat;
    float f = fv * (1.0 + uP0.y);
    float g = fxLuma(s);
    fxOut(fxPm(clamp(vec3(g) + (s - g) * f, 0.0, 1.0), c.a));
}
