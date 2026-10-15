// Twirl.  uP0 = (angle rad, radius px, centerX frac, centerY frac), uP1.x = edge (0 transparent / 1 clamp / 2 mirror / 3 wrap)
void main() {
    vec2 p = vec2(fxDoc(fxPos())) + 0.5;
    vec2 c = uP0.zw * vec2(fxDocSize());
    vec2 v = p - c;
    float t = min(length(v) / max(uP0.y, 1.0), 1.0);
    float a = uP0.x * (1.0 - t * t * (3.0 - 2.0 * t));
    float cs = fxCos(a), sn = fxSin(a);
    // source = rotate v by -a (screen y down: [c s; -s c])
    vec2 q = c + vec2(cs * v.x + sn * v.y, -sn * v.x + cs * v.y);
    fxOut(fxSampleDoc(q, int(uP1.x + 0.5)));
}
