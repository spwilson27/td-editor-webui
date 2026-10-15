// Radial (spin) blur.  uP0 = (arc in radians, centre x fraction, centre y fraction, 0)
void main() {
    ivec2 f = fxPos();
    vec2 D = vec2(fxDocSize());
    vec2 ctr = uP0.yz * D;
    vec2 p = vec2(fxDoc(f)) + 0.5;
    vec2 d = p - ctr;
    float r = length(d);
    float arc = uP0.x * r;
    int n = int(clamp(ceil(arc), 1.0, 64.0));
    if (n <= 1) { fxOut(fxSrc(f)); return; }
    vec4 acc = vec4(0.0);
    for (int i = 0; i < 64; i++) {
        if (i >= n) break;
        float ph = ((float(i) + 0.5) / float(n) - 0.5) * uP0.x;
        float cs = fxCos(ph), sn = fxSin(ph);
        vec2 q = ctr + vec2(d.x * cs - d.y * sn, d.x * sn + d.y * cs);
        acc += fxSampleDoc(q, 0);
    }
    fxOut(acc / float(n));
}
