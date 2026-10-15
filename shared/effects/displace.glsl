// Displace.  Every pass has input 2 (the aux image or a dummy).
//   uP0 = (source 0 noise / 1 aux, strengthX px, strengthY px, edge 0 transparent / 1 clamp / 2 mirror / 3 wrap)
//   uP1 = (noise scale px, octaves, seed, 0)
void main() {
    ivec2 f = fxPos();
    ivec2 d = fxDoc(f);
    vec2 st = vec2(uP0.y, uP0.z);
    int edge = int(uP0.w + 0.5);
    vec2 off = vec2(0.0);
    if (uP0.x < 0.5) {
        uint seed = uint(uP1.z + 0.5);
        vec2 q = (vec2(d) + 0.5) / max(uP1.x, 1.0);
        int oct = int(uP1.y + 0.5);
        off = vec2(fxFbm(q, seed, oct), fxFbm(q + vec2(31.7, 17.3), seed + 7u, oct)) * 2.0 - 1.0;
    } else if (!fxAuxMissing()) {
        vec4 a = fxAux2(f);
        vec3 s = a.a > 1e-6 ? fxStraight(a) : vec3(0.5);
        off = s.rg * 2.0 - 1.0;
    }
    off *= st;
    fxOut(fxSampleDoc(vec2(d) + 0.5 + off, edge));
}
