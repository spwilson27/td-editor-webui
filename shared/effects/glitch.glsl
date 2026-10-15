// Glitch (experimental), deterministic: everything derives from an integer hash of (seed, band index); no time, no
// textures.  1 pass.  Horizontal bands of `blockSize` document px (band index = document y / blockSize).  Each band is
// glitched with probability p; a glitched band is displaced horizontally by a random amount in [-maxShift, maxShift]
// and its red / blue channels are additionally split by +-rgbShift * (0.5..1.5) px.  Other bands are untouched.
// Outside the texture is transparent (no wrap).  alpha = max of the three channel alphas.
//   uP0 = (p = amount/100, maxShift px = amount, blockSize px >= 1, seed (integer))     uP1 = (rgbShift px, 0, 0, 0)
void main() {
    ivec2 f = fxPos();
    ivec2 d = fxDoc(f);
    int bs = max(int(uP0.z + 0.5), 1);
    int band = d.y / bs;
    uint h = fxHash(uint(band) * 0x9e3779b1u + uint(int(uP0.w)) * 0x85ebca6bu + 0x165667b1u);
    vec4 c;
    if (fxRand(h) < uP0.x) {
        uint h2 = fxHash(h + 1u);
        uint h3 = fxHash(h + 2u);
        int shift = int(floor((fxRand(h2) * 2.0 - 1.0) * uP0.y + 0.5));
        int rs = int(floor(uP1.x * (0.5 + fxRand(h3)) + 0.5));
        vec4 g = fxSrc(f + ivec2(-shift, 0));
        vec4 r = fxSrc(f + ivec2(-shift + rs, 0));
        vec4 b = fxSrc(f + ivec2(-shift - rs, 0));
        c = vec4(r.r, g.g, b.b, max(r.a, max(g.a, b.a)));
    } else {
        c = fxSrc(f);
    }
    fxOut(c);
}
