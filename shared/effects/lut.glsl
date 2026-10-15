// 3D LUT (.cube).  Input 2 = atlas RGBA8: g x g tiles of n x n texels; tile b = blue slice b at tile column b % g, tile row b / g; texel
// (red index, green index) inside the tile; data row 0 = first row (fxData).  Red varies fastest in the file, blue slowest.
// uP0 = (n, g, min r, min g), uP1 = (min b, max r, max g, max b), uP2 = (intensity 0..1, 0, 0, 0).
// u = clamp((c - min) / (max - min)) * (n - 1); trilinear between the 8 neighbouring lattice points; out = mix(c, lut(c), intensity).
vec3 lutAt(int n, int g, int r, int gg, int b) {
    int tx = b - (b / g) * g;
    int ty = b / g;
    return fxData(tx * n + r, ty * n + gg).rgb;
}
void main() {
    vec4 c = fxSrc(fxPos());
    vec3 s = fxStraight(c);
    int n = int(uP0.x + 0.5);
    int g = int(uP0.y + 0.5);
    vec3 dmin = vec3(uP0.z, uP0.w, uP1.x);
    vec3 dmax = vec3(uP1.y, uP1.z, uP1.w);
    vec3 u = clamp((s - dmin) / max(dmax - dmin, vec3(1e-6)), 0.0, 1.0) * float(n - 1);
    vec3 fl = floor(u);
    vec3 w = u - fl;
    int r0 = min(int(fl.r), n - 1), g0 = min(int(fl.g), n - 1), b0 = min(int(fl.b), n - 1);
    int r1 = min(r0 + 1, n - 1), g1 = min(g0 + 1, n - 1), b1 = min(b0 + 1, n - 1);
    vec3 c00 = mix(lutAt(n, g, r0, g0, b0), lutAt(n, g, r1, g0, b0), w.r);
    vec3 c10 = mix(lutAt(n, g, r0, g1, b0), lutAt(n, g, r1, g1, b0), w.r);
    vec3 c01 = mix(lutAt(n, g, r0, g0, b1), lutAt(n, g, r1, g0, b1), w.r);
    vec3 c11 = mix(lutAt(n, g, r0, g1, b1), lutAt(n, g, r1, g1, b1), w.r);
    vec3 o = mix(mix(c00, c10, w.g), mix(c01, c11, w.g), w.b);
    fxOut(fxPm(mix(s, o, uP2.x), c.a));
}
