// Selective colour.  Input 2 = 9 x 1 RGBA8 table, texel i = range i (reds, yellows, greens, cyans, blues, magentas, whites, neutrals,
// blacks) holding (cyan, magenta, yellow, black) as byte = round((v + 1) * 127.5), v = byte / 127.5 - 1.  uP0 = (relative 0/1, 0, 0, 0).
// Weights of the straight colour (hue h in degrees, chroma = max - min, L = Rec.709 luma):
//   colour range k (centre 60 k deg):  max(0, 1 - hueDist / 60) * chroma
//   whites smoothstep(0.5, 1, min channel);  blacks smoothstep(0.5, 1, 1 - max channel);
//   neutrals (1 - smoothstep(0, 0.25, chroma)) * (1 - |2 L - 1|)
// Inks C,M,Y = 1 - R,G,B and K = min(C,M,Y).  ink' = ink + sum_range w * a_ink * (relative ? ink : 1) ; the black adjustment adds
// sum w * a_k * (relative ? K : 1) to all three inks.  out = 1 - clamp(ink').
float scDecode(float b) {
    float v = b * 255.0 / 127.5 - 1.0;
    return abs(v) < 0.005 ? 0.0 : v;   // byte 128 encodes 0.0039: snap the neutral code back to exactly 0
}
void main() {
    vec4 c = fxSrc(fxPos());
    vec3 s = fxStraight(c);
    float mx = max(max(s.r, s.g), s.b);
    float mn = min(min(s.r, s.g), s.b);
    float chroma = mx - mn;
    float hue = fxHue(s) * 360.0;
    float L = fxLuma(s);
    float w[9];
    for (int k = 0; k < 6; k++) {
        float d = abs(hue - 60.0 * float(k));
        d = min(d, 360.0 - d);
        w[k] = max(0.0, 1.0 - d / 60.0) * chroma;
    }
    w[6] = smoothstep(0.5, 1.0, mn);
    w[7] = (1.0 - smoothstep(0.0, 0.25, chroma)) * (1.0 - abs(2.0 * L - 1.0));
    w[8] = smoothstep(0.5, 1.0, 1.0 - mx);
    vec3 ink = vec3(1.0) - s;
    float K = min(min(ink.r, ink.g), ink.b);
    bool rel = uP0.x > 0.5;
    vec3 add = vec3(0.0);
    float addK = 0.0;
    for (int k = 0; k < 9; k++) {
        if (w[k] <= 0.0) continue;
        vec4 t = fxData(k, 0);
        vec3 a = vec3(scDecode(t.r), scDecode(t.g), scDecode(t.b));
        add += w[k] * a * (rel ? ink : vec3(1.0));
        addK += w[k] * scDecode(t.a) * (rel ? K : 1.0);
    }
    vec3 o = vec3(1.0) - clamp(ink + add + vec3(addK), 0.0, 1.0);
    fxOut(fxPm(o, c.a));
}
