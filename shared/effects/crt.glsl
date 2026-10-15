// CRT.   uP0 = (scanlines 0..1, period px, mask 0 none | 1 aperture | 2 slot, maskStrength 0..1)   uP1 = (curvature 0..1, vignette 0..1, glow 0..1, 0)
// Output pixel centre p (document px), uv = 2 p / docSize - 1 in -1..1 (screen space of the OUTPUT).  Steps, on premultiplied rgb, alpha kept:
//  1. curvature k = 0.4 * curvature: source uv' = uv + uv * (uv.yx)^2 * k (barrel); the source is read bilinearly there; outputs with |uv'| > 1 are
//     the bezel: opaque black (0,0,0,1).  curvature 0 reads the pixel itself.
//  2. glow: mean over 5x5 taps at 2 px spacing (offsets -4..4) around the source position of max(c - 0.5, 0) * 2 ; rgb += mean * glow * 2.
//  3. scanlines: ph = (mod(y_doc, period) + 0.5) / period, s = 0.5 - 0.5 cos(2 pi ph) (0 on the line gap, 1 in the middle), rgb *= 1 - scanlines * (1 - s).
//  4. mask on integer document columns: aperture: channel (x mod 3) keeps 1, the others get 1 - maskStrength; slot: the same plus every 4th row of
//     each triad is dark (1 - maskStrength), staggered by 2 rows for odd triads.
//  5. vignette: rgb *= 1 - vignette * (uv.x^2 + uv.y^2) / 2 (corner = 1 - vignette).    Finally rgb clamped to [0, alpha].
void main() {
    ivec2 f = fxPos();
    ivec2 d = fxDoc(f);
    vec2 D = vec2(fxDocSize());
    vec2 pd = vec2(d) + 0.5;
    vec2 uv = pd / D * 2.0 - 1.0;
    float curv = uP1.x * 0.4;
    vec2 qd = pd;
    bool curved = uP1.x > 0.0;
    if (curved) {
        vec2 q = uv + uv * (uv.yx * uv.yx) * curv;
        if (abs(q.x) > 1.0 || abs(q.y) > 1.0) { fxOut(vec4(0.0, 0.0, 0.0, 1.0)); return; }
        qd = (q * 0.5 + 0.5) * D;
    }
    vec4 c = curved ? fxSampleDoc(qd, 0) : fxSrc(f);
    vec3 rgb = c.rgb;
    if (uP1.z > 0.0) {
        vec3 acc = vec3(0.0);
        for (int j = -2; j <= 2; j++) {
            for (int i = -2; i <= 2; i++) {
                vec4 t = curved ? fxSampleDoc(qd + vec2(float(i), float(j)) * 2.0, 0) : fxSrc(f + ivec2(i, j) * 2);
                acc += max(t.rgb - 0.5, 0.0) * 2.0;
            }
        }
        rgb += acc / 25.0 * uP1.z * 2.0;
    }
    if (uP0.x > 0.0) {
        float per = uP0.y;
        float ph = (mod(float(d.y), per) + 0.5) / per;
        float s = 0.5 - 0.5 * cos(2.0 * FX_PI * ph);
        rgb *= 1.0 - uP0.x * (1.0 - s);
    }
    if (uP0.z > 0.5) {
        int tri = d.x / 3;
        int ch = d.x - 3 * tri;
        vec3 w = vec3(1.0 - uP0.w) + uP0.w * vec3(ch == 0 ? 1.0 : 0.0, ch == 1 ? 1.0 : 0.0, ch == 2 ? 1.0 : 0.0);
        if (uP0.z > 1.5) {
            int r = (d.y + 2 * (tri & 1)) & 3;
            if (r == 3) w *= 1.0 - uP0.w;
        }
        rgb *= w;
    }
    if (uP1.y > 0.0) rgb *= 1.0 - uP1.y * dot(uv, uv) * 0.5;
    fxOut(vec4(clamp(rgb, 0.0, c.a), c.a));
}
