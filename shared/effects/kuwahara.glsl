// Kuwahara (oil paint) with the classic 4 overlapping quadrants.   uP0 = (n, stride, 0, 0)
// Window = (2n+1)^2 taps at stride px spacing (stride = ceil(radius / 6), n = floor(radius / stride): at most 13x13 = 169 taps, exact for radius <= 6,
// larger radii are stride-subsampled).  Quadrant q (TL, TR, BL, BR) = the taps with dx<=0|>=0 and dy<=0|>=0 (the axes belong to two or four quadrants),
// each (n+1)^2 taps.  The sums run over PREMULTIPLIED rgba (== alpha weighted mean of the straight colour); the variance is that of the integer luma (54r+183g+19b+128)>>8 of the exact integer straight 8-bit colour, compared exactly as N*S2 - S1^2; the output is the mean rgba of the quadrant with the lowest variance (first wins on ties).  alpha = mean alpha of that quadrant.
// exact integer straight 8-bit colour of a premultiplied texel: k = round(c*255), m = round(a*255), straight = min((510 k + m) / (2 m), 255), 0 if m = 0
ivec3 fxStraight8(vec4 c) {
    int m = int(floor(c.a * 255.0 + 0.5));
    if (m <= 0) return ivec3(0);
    ivec3 k = ivec3(floor(c.rgb * 255.0 + 0.5));
    return min((510 * k + m) / (2 * m), ivec3(255));
}
void main() {
    ivec2 f = fxPos();
    int n = int(uP0.x + 0.5);
    int st = int(uP0.y + 0.5);
    vec4 sm[4];
    ivec2 sl[4];
    for (int k = 0; k < 4; k++) { sm[k] = vec4(0.0); sl[k] = ivec2(0); }
    for (int j = -n; j <= n; j++) {
        for (int i = -n; i <= n; i++) {
            vec4 c = fxSrc(f + ivec2(i, j) * st);
            ivec3 s8 = fxStraight8(c);
            int l = (54 * s8.r + 183 * s8.g + 19 * s8.b + 128) >> 8;
            ivec2 ll = ivec2(l, l * l);
            if (i <= 0 && j <= 0) { sm[0] += c; sl[0] += ll; }
            if (i >= 0 && j <= 0) { sm[1] += c; sl[1] += ll; }
            if (i <= 0 && j >= 0) { sm[2] += c; sl[2] += ll; }
            if (i >= 0 && j >= 0) { sm[3] += c; sl[3] += ll; }
        }
    }
    int N = (n + 1) * (n + 1);
    int best = 0;
    int bv = 0x7fffffff;
    for (int k = 0; k < 4; k++) {
        int v = N * sl[k].y - sl[k].x * sl[k].x;   // N^2 * variance, exact
        if (v < bv) { bv = v; best = k; }
    }
    fxOut(sm[best] / float(N));
}
