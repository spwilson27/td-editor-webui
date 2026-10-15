// Lens distortion.  uP0 = (k1, k2, zoom, edge), uP1 = (centerX, centerY frac, 0, 0).  Inverse mapping per output pixel (see spec doc).
void main() {
    vec2 D = vec2(fxDocSize());
    vec2 p = vec2(fxDoc(fxPos())) + 0.5;
    vec2 c = uP1.xy * D;
    float H = max(0.5 * length(D), 1.0);
    vec2 x = (p - c) / H;
    float r2 = dot(x, x);
    float f = (1.0 + uP0.x * r2 + uP0.y * r2 * r2) / max(uP0.z, 0.01);
    fxOut(fxSampleDoc(c + (p - c) * f, int(uP0.w + 0.5)));
}
