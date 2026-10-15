// Colour cycling (static palette-cycling frame), point operation.  Colour model: YIQ (Y = 0.299 r + 0.587 g + 0.114 b; (I, Q) rotated by the phase = hue
// rotation that keeps Y and the chroma magnitude).  s_0 = straight colour.  For i = 1..n:
//   luma = Rec.709 luma of s_{i-1} (re-evaluated after every iteration; differs from the YIQ Y so it changes while the colour cycles)
//   phase += hueStep * (1 + lumaWarp * (2 * luma - 1))                (degrees; lumaWarp 0..1)
//   ph = bands >= 2 ? round(phase / (360 / bands)) * (360 / bands) : phase
//   s_i = clamp(rotateYIQ(s_0, ph), 0, 1)
// Finally chroma (I, Q) is scaled by 1 + saturationBoost and clamped.  Alpha unchanged.
//   uP0 = (n, hueStep deg, lumaWarp 0..1, saturationBoost 0..1)   uP1 = (bands, 0, 0, 0)
vec3 fxToYiq(vec3 c) {
    return vec3(dot(c, vec3(0.299, 0.587, 0.114)), dot(c, vec3(0.596, -0.274, -0.322)), dot(c, vec3(0.211, -0.523, 0.312)));
}
vec3 fxFromYiq(vec3 y) {
    return vec3(y.x + 0.956 * y.y + 0.621 * y.z, y.x - 0.272 * y.y - 0.647 * y.z, y.x - 1.106 * y.y + 1.703 * y.z);
}
vec3 fxRotYiq(vec3 y, float deg) {
    float a = radians(mod(deg, 360.0));
    float cs = cos(a);
    float sn = sin(a);
    return vec3(y.x, y.y * cs - y.z * sn, y.y * sn + y.z * cs);
}
void main() {
    vec4 c = fxSrc(fxPos());
    vec3 s0 = fxStraight(c);
    vec3 y0 = fxToYiq(s0);
    int n = int(uP0.x + 0.5);
    float bands = uP1.x;
    float q = bands >= 2.0 ? 360.0 / bands : 0.0;
    vec3 s = s0;
    float phase = 0.0;
    for (int i = 0; i < 64; i++) {
        if (i >= n) break;
        float l = fxLuma(s);
        phase += uP0.y * (1.0 + uP0.z * (2.0 * l - 1.0));
        float ph = q > 0.0 ? floor(phase / q + 0.5) * q : phase;
        s = clamp(fxFromYiq(fxRotYiq(y0, ph)), 0.0, 1.0);
    }
    vec3 y = fxToYiq(s);
    y.yz *= 1.0 + uP0.w;
    fxOut(fxPm(clamp(fxFromYiq(y), 0.0, 1.0), c.a));
}
