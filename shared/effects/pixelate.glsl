// Pixelate: square cells of `size` px aligned to DOCUMENT coordinates (cell = floor(doc / size)).   uP0 = (size, sample 0 mean | 1 centre, 0, 0)
// centre: the pixel at cell origin + size/2 (integer division), clamped into the document.
// mean: average of n x n taps, n = min(size, 16), tap k at offset floor((2k + 1) * size / (2n)) from the cell origin (exact mean for size <= 16,
// a regular stride subsample above); tap positions are clamped into the document so cells cut by the document border stay uniform.
void main() {
    ivec2 f = fxPos();
    ivec2 d = fxDoc(f);
    ivec2 org = d - f;
    ivec2 D = fxDocSize();
    int sz = int(uP0.x + 0.5);
    ivec2 o = (d / sz) * sz;
    if (uP0.y > 0.5) {
        ivec2 p = clamp(o + sz / 2, ivec2(0), D - ivec2(1));
        fxOut(fxSrc(p - org));
        return;
    }
    int n = min(sz, 16);
    vec4 acc = vec4(0.0);
    for (int j = 0; j < 16; j++) {
        if (j >= n) break;
        int oy = ((2 * j + 1) * sz) / (2 * n);
        for (int i = 0; i < 16; i++) {
            if (i >= n) break;
            int ox = ((2 * i + 1) * sz) / (2 * n);
            ivec2 p = clamp(o + ivec2(ox, oy), ivec2(0), D - ivec2(1));
            acc += fxSrc(p - org);
        }
    }
    fxOut(acc / float(n * n));
}
