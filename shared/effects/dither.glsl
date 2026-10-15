// Dither (quantise to `levels` values per channel).   uP0 = (mode 0 ordered | 1 diffusion, levels L 2..16, Bayer size 2|4|8, colour 0/1)
//   uP1 = (strength 0..1, 0, 0, 0)
// All colour work is on the STRAIGHT 8-bit colour recovered with exact integer maths (fxStraight8: no float division); colour = 0 quantises the luma and outputs grey; the result is mixed with the original by strength.
// ordered: Bayer threshold t = (M(x mod n, y mod n) + 0.5) / n^2 - 0.5 with the recursive Bayer matrix M_2n = [[4M, 4M+2], [4M+3, 4M+1]] taken at
//   DOCUMENT coordinates; q = clamp(floor(v * (L-1) + 0.5 + t), 0, L-1), out = q / (L-1) (already quantised values are unchanged).
// diffusion: WINDOWED Floyd-Steinberg, integer arithmetic only (see the spec doc).  Every pixel re-runs the sequential algorithm on the
//   causal window rows y-K..y, columns x-2K..x+K (K = 6, left to right, no serpentine), starting with a pseudo-random error (hash of the document position, +- half a step) entering from the top row and the left column,
//   and outputs the quantised value of the last pixel.  Values are 8-bit straight colour * 16 (4 fractional bits); error shares are
//   floor(e * w / 16) (7, 3, 5, 1) computed with a positive-offset shift (no reliance on negative shifts).  Pixels outside the document repeat
//   the nearest document pixel.  Colour mode runs the 3 channels independently (ivec3); grey mode runs the integer luma
//   (54 r + 183 g + 19 b + 128) >> 8 in all three lanes.
// exact integer straight 8-bit colour of a premultiplied texel: k = round(c*255), m = round(a*255), straight = min((510 k + m) / (2 m), 255), 0 if m = 0
ivec3 fxStraight8(vec4 c) {
    int m = int(floor(c.a * 255.0 + 0.5));
    if (m <= 0) return ivec3(0);
    ivec3 k = ivec3(floor(c.rgb * 255.0 + 0.5));
    return min((510 * k + m) / (2 * m), ivec3(255));
}
const int DK = 6;
const int DWD = 19;   // 3K + 1 columns

int bayer(ivec2 p, int k) {
    int idx = 0;
    for (int b = 0; b < 3; b++) {
        if (b >= k) break;
        int bx = (p.x >> b) & 1;
        int by = (p.y >> b) & 1;
        idx = idx * 4 + (((bx ^ by) << 1) | by);
    }
    return idx;
}

ivec3 fx16(ivec3 a) { return ((a + 1048576) >> 4) - 65536; }

// pseudo-random error entering the window from outside (top row and left column), a hash of the DOCUMENT position only: uniform in
// +-half a quantisation step.  Without it every pixel of a flat area would simulate the very same window and get the same value.
ivec3 ditherSeed(ivec2 p, int hs) {
    ivec3 r;
    for (int c = 0; c < 3; c++) {
        int v = int(fxHash2(p, 77u + uint(c)) & 255u) - 128;
        r[c] = ((v * hs + 1048576) >> 7) - 8192;
    }
    return r;
}

ivec3 ditherPix(ivec2 dp, ivec2 D, ivec2 org, bool mono) {
    ivec2 c = clamp(dp, ivec2(0), D - ivec2(1));
    ivec3 i = fxStraight8(fxSrc(c - org));
    if (mono) { int l = (54 * i.r + 183 * i.g + 19 * i.b + 128) >> 8; i = ivec3(l); }
    return i;
}

void main() {
    ivec2 f = fxPos();
    vec4 c0 = fxSrc(f);
    ivec3 s8 = fxStraight8(c0);
    vec3 s = vec3(s8) / 255.0;
    int L = int(uP0.y + 0.5);
    float lm = float(L - 1);
    bool mono = uP0.w < 0.5;
    vec3 res;
    if (uP0.x < 0.5) {
        ivec2 d = fxDoc(f);
        int n = int(uP0.z + 0.5);
        int k = n >= 8 ? 3 : (n >= 4 ? 2 : 1);
        int sz = 1 << k;
        ivec2 pp = ivec2(d.x & (sz - 1), d.y & (sz - 1));
        float t = (float(bayer(pp, k)) + 0.5) / float(sz * sz) - 0.5;
        vec3 v = mono ? vec3(float((54 * s8.r + 183 * s8.g + 19 * s8.b + 128) >> 8) / 255.0) : s;
        res = clamp(floor(v * lm + 0.5 + t), 0.0, lm) / lm;
    } else {
        ivec2 D = fxDocSize();
        ivec2 d = fxDoc(f);
        ivec2 org = d - f;
        ivec3 cur[20];
        ivec3 nxt[20];
        for (int i = 0; i < 20; i++) { cur[i] = ivec3(0); nxt[i] = ivec3(0); }
        ivec3 outq = ivec3(0);
        int l1 = L - 1;
        int hs = 2040 / l1;   // half a quantisation step (x16)
        for (int i = 0; i < DWD; i++) cur[i] = ditherSeed(ivec2(d.x - 2 * DK + i, d.y - DK), hs);
        for (int j = 0; j <= DK; j++) {
            int lim = j == DK ? 2 * DK : DWD - 1;
            if (j > 0) cur[0] += ditherSeed(ivec2(d.x - 2 * DK - 1, d.y - DK + j), hs);
            for (int i = 0; i < DWD; i++) {
                if (i > lim) break;
                ivec3 p = ditherPix(ivec2(d.x - 2 * DK + i, d.y - DK + j), D, org, mono) * 16 + cur[i];
                p = clamp(p, ivec3(0), ivec3(4080));
                ivec3 q = (p * (2 * l1) + 4080) / 8160;
                q = clamp(q, ivec3(0), ivec3(l1));
                ivec3 o = (q * 8160 + l1) / (2 * l1);
                ivec3 e = p - o;
                if (j == DK && i == 2 * DK) outq = q;
                if (i + 1 < DWD) cur[i + 1] += fx16(e * 7);
                if (j < DK) {
                    if (i > 0) nxt[i - 1] += fx16(e * 3);
                    nxt[i] += fx16(e * 5);
                    if (i + 1 < DWD) nxt[i + 1] += fx16(e);
                }
            }
            if (j < DK) {
                for (int i = 0; i < 20; i++) { cur[i] = nxt[i]; nxt[i] = ivec3(0); }
            }
        }
        res = vec3(outq) / lm;
        if (mono) res = vec3(res.r);
    }
    fxOut(fxPm(mix(s, res, uP1.x), c0.a));
}
