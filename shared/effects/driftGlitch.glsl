// Drift glitch (static version of an animated glitch).  1 pass, everything derives from fxHash of (seed, band, step); no time, no textures.
// Bands: strips of `blockSize` document px across the shift axis (axis h: band = doc y / blockSize, shifted along x; axis v: band = doc x / blockSize,
// shifted along y).  Over n steps each band's offset random-walks: step i adds (rand2 - 0.5) * 2 * amount px when rand1(seed, band, i) < p (density).
// Accumulated offset o (px).  Green is taken at round(o); red at round(o + k), blue at round(o - k) with k = o * rgbShift / amount, so the red/blue split
// is proportional to the drift and |k| <= n * rgbShift.  out(x) = in(x - shift).  Outside the layer is transparent (no wrap); alpha = max of the 3 alphas.
//   uP0 = (iterations n 1..64, amount px, blockSize px >= 1, p = density / 100)     uP1 = (rgbShift px, seed, axis (0 h, 1 v), 0)
void main() {
    ivec2 f = fxPos();
    ivec2 d = fxDoc(f);
    int n = int(uP0.x + 0.5);
    float amount = uP0.y;
    int bs = max(int(uP0.z + 0.5), 1);
    float p = uP0.w;
    uint seed = uint(int(uP1.y + 0.5));
    bool vert = uP1.z > 0.5;
    int band = (vert ? d.x : d.y) / bs;
    float off = 0.0;
    for (int i = 0; i < 64; i++) {
        if (i >= n) break;
        uint h = fxHash(uint(band) * 0x9e3779b1u + seed * 0x85ebca6bu + uint(i) * 0xc2b2ae35u + 0x165667b1u);
        if (fxRand(h) < p) {
            uint h2 = fxHash(h + 1u);
            off += (fxRand(h2) - 0.5) * 2.0 * amount;
        }
    }
    float k = amount > 0.0 ? off * uP1.x / amount : 0.0;
    int sg = int(floor(off + 0.5));
    int sr = int(floor(off + k + 0.5));
    int sb = int(floor(off - k + 0.5));
    ivec2 e = vert ? ivec2(0, 1) : ivec2(1, 0);
    vec4 g = fxSrc(f - e * sg);
    vec4 r = fxSrc(f - e * sr);
    vec4 b = fxSrc(f - e * sb);
    fxOut(vec4(r.r, g.g, b.b, max(r.a, max(g.a, b.a))));
}
