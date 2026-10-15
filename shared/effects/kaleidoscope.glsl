// Kaleidoscope.  uP0 = (segments, angle rad, centerX, centerY), uP1 = (zoom factor, edge, 0, 0)
void main() {
    vec2 D = vec2(fxDocSize());
    vec2 p = vec2(fxDoc(fxPos())) + 0.5;
    vec2 c = uP0.zw * D;
    vec2 v = p - c;
    float S = 6.28318530718 / max(uP0.x, 1.0);
    float a = fxAtan2(v.y, v.x);
    float m = mod(a, S);
    float f = 0.5 * S - abs(m - 0.5 * S) + uP0.y;
    vec2 q = c + length(v) / max(uP1.x, 0.01) * vec2(fxCos(f), fxSin(f));
    fxOut(fxSampleDoc(q, int(uP1.y + 0.5)));
}
