// Ripple.  uP0 = (kind 0 wave / 1 ripple, amplitude px, wavelength px, phase rad), uP1 = (angle rad, centerX, centerY, decay %), uP2.x = edge
void main() {
    vec2 D = vec2(fxDocSize());
    vec2 p = vec2(fxDoc(fxPos())) + 0.5;
    float A = uP0.y;
    float k = 6.28318530718 / max(uP0.z, 1.0);
    vec2 q = p;
    if (uP0.x < 0.5) {
        vec2 u = vec2(fxCos(uP1.x), fxSin(uP1.x));
        vec2 n = vec2(-u.y, u.x);
        q = p + n * (A * fxSin(k * dot(p, u) + uP0.w));
    } else {
        vec2 c = uP1.yz * D;
        vec2 v = p - c;
        float r = length(v);
        float hd = 0.5 * length(D);
        float g = exp(-5.0 * (uP1.w * 0.01) * r / max(hd, 1.0));
        if (r > 1e-4) q = p + v / r * (A * g * fxSin(k * r + uP0.w));
    }
    fxOut(fxSampleDoc(q, int(uP2.x + 0.5)));
}
