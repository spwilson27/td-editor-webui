// Zoom blur.  uP0 = (streak fraction 0..1 of the distance to the centre, centre x fraction, centre y fraction, 0)
void main() {
    ivec2 f = fxPos();
    vec2 D = vec2(fxDocSize());
    vec2 ctr = uP0.yz * D;
    vec2 p = vec2(fxDoc(f)) + 0.5;
    vec2 d = p - ctr;
    float len = uP0.x * length(d);
    int n = int(clamp(ceil(len), 1.0, 64.0));
    if (n <= 1) { fxOut(fxSrc(f)); return; }
    vec4 acc = vec4(0.0);
    for (int i = 0; i < 64; i++) {
        if (i >= n) break;
        float u = float(i) / float(n);
        acc += fxSampleDoc(ctr + d * (1.0 - uP0.x * u), 0);
    }
    fxOut(acc / float(n));
}
