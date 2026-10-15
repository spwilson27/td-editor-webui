// Polar coordinates.  uP0 = (mode 0 rectToPolar / 1 polarToRect, centerX, centerY, angleOffset rad), uP1 = (radiusScale factor, edge, 0, 0)
// Bilinear read whose x is wrapped around the document width (seamless polar seam); y goes through the edge mode.
vec4 polarRead(vec2 q, int edge) {
    vec2 D = vec2(fxDocSize());
    vec2 t = q - 0.5;
    vec2 fl = floor(t);
    vec2 w = t - fl;
    float x0 = mod(fl.x, D.x), x1 = mod(fl.x + 1.0, D.x);
    vec4 a = mix(fxSampleDoc(vec2(x0 + 0.5, fl.y + 0.5), edge), fxSampleDoc(vec2(x1 + 0.5, fl.y + 0.5), edge), w.x);
    vec4 b = mix(fxSampleDoc(vec2(x0 + 0.5, fl.y + 1.5), edge), fxSampleDoc(vec2(x1 + 0.5, fl.y + 1.5), edge), w.x);
    return mix(a, b, w.y);
}
void main() {
    vec2 D = vec2(fxDocSize());
    vec2 p = vec2(fxDoc(fxPos())) + 0.5;
    vec2 c = uP0.yz * D;
    float R = max(uP1.x * 0.5 * min(D.x, D.y), 1e-3);
    int edge = int(uP1.y + 0.5);
    float TAU = 6.28318530718;
    vec2 q;
    if (uP0.x < 0.5) {
        vec2 v = p - c;
        float a = fxAtan2(v.x, -v.y) - uP0.w;
        float u = fract(a / TAU);
        q = vec2(u * D.x, length(v) / R * D.y);
    } else {
        float a = p.x / D.x * TAU + uP0.w;
        float r = p.y / D.y * R;
        q = c + r * vec2(fxSin(a), -fxCos(a));
    }
    if (uP0.x < 0.5) fxOut(polarRead(q, edge));
    else fxOut(fxSampleDoc(q, edge));
}
