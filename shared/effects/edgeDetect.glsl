// Edge detection on the luma of the PREMULTIPLIED colour (alpha edges are edges too), 3x3 neighbourhood.
//   uP0 = (method 0 sobel | 1 laplacian, strength (1 = 100 %), threshold 0..1, invert 0/1)   uP1 = (mode 0 edges | 1 overlay, 0, 0, 0)
// sobel: e = sqrt(gx^2 + gy^2) / 4 (a black/white step along an axis = 1);  laplacian (8 neighbours): e = |8 c - sum(neighbours)| / 4.
// e = clamp(e * strength); e < threshold -> 0.  edges: straight rgb = invert ? 1 - e : e (grey), alpha unchanged;
// overlay: straight rgb = original + e (invert: original - e, i.e. dark lines).
void main() {
    ivec2 f = fxPos();
    vec4 c0 = fxSrc(f);
    float a = fxLuma(fxSrc(f + ivec2(-1, -1)).rgb);
    float b = fxLuma(fxSrc(f + ivec2(0, -1)).rgb);
    float c = fxLuma(fxSrc(f + ivec2(1, -1)).rgb);
    float d = fxLuma(fxSrc(f + ivec2(-1, 0)).rgb);
    float m = fxLuma(c0.rgb);
    float e = fxLuma(fxSrc(f + ivec2(1, 0)).rgb);
    float g = fxLuma(fxSrc(f + ivec2(-1, 1)).rgb);
    float h = fxLuma(fxSrc(f + ivec2(0, 1)).rgb);
    float i = fxLuma(fxSrc(f + ivec2(1, 1)).rgb);
    float v;
    if (uP0.x < 0.5) {
        float gx = (c + 2.0 * e + i) - (a + 2.0 * d + g);
        float gy = (g + 2.0 * h + i) - (a + 2.0 * b + c);
        v = sqrt(gx * gx + gy * gy) * 0.25;
    } else {
        v = abs(8.0 * m - (a + b + c + d + e + g + h + i)) * 0.25;
    }
    v = clamp(v * uP0.y, 0.0, 1.0);
    if (int(floor(v * 255.0 + 0.5)) < int(floor(uP0.z * 255.0 + 0.5))) v = 0.0;   // threshold compared on 8-bit quantised values
    bool inv = uP0.w > 0.5;
    vec3 o;
    if (uP1.x > 0.5) o = fxStraight(c0) + (inv ? -v : v);
    else o = vec3(inv ? 1.0 - v : v);
    fxOut(fxPm(clamp(o, 0.0, 1.0), c0.a));
}
