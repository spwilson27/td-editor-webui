// Grain.   uP0 = (amount 0..1, cell size px, kind 0 film | 1 noise, colour 0/1)   uP1 = (seed, 0, 0, 0)
// cell = floor(document position / size); u_k = fxRand2(cell, seed * 16 + k), k = 0..3 per channel lane (lane c uses k = 4c..4c+3; monochrome: lane 0).
// noise: delta = (2 u - 1) * amount * 0.5.
// film: g = (u0 + u1 + u2 + u3 - 2) * sqrt(3) (approx gaussian, sd 1, |g| <= 3.46), delta = g * amount * 0.2 * 4 l (1 - l), l = luma of the straight colour.
// straight colour += delta, clamped; alpha untouched; the result is premultiplied again so grain on transparent pixels vanishes (scaled by alpha).
float grainU(ivec2 cell, uint seed, int k) { return fxRand2(cell, seed * 16u + uint(k)); }

float grainDelta(ivec2 cell, uint seed, int lane, bool film, float amt, float l) {
    if (!film) return (2.0 * grainU(cell, seed, lane * 4) - 1.0) * amt * 0.5;
    float g = grainU(cell, seed, lane * 4) + grainU(cell, seed, lane * 4 + 1) + grainU(cell, seed, lane * 4 + 2) + grainU(cell, seed, lane * 4 + 3) - 2.0;
    return g * 1.7320508 * amt * 0.2 * 4.0 * l * (1.0 - l);
}

void main() {
    ivec2 f = fxPos();
    vec4 c = fxSrc(f);
    vec3 s = fxStraight(c);
    int sz = int(uP0.y + 0.5);
    ivec2 cell = fxDoc(f) / sz;
    uint seed = uint(uP1.x + 0.5);
    bool film = uP0.z < 0.5;
    float amt = uP0.x;
    float l = fxLuma(s);
    vec3 d;
    if (uP0.w > 0.5) d = vec3(grainDelta(cell, seed, 0, film, amt, l), grainDelta(cell, seed, 1, film, amt, l), grainDelta(cell, seed, 2, film, amt, l));
    else d = vec3(grainDelta(cell, seed, 0, film, amt, l));
    fxOut(fxPm(clamp(s + d, 0.0, 1.0), c.a));
}
