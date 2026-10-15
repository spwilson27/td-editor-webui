// Gradient map: input 2 = 256 x 1 RGBA8 gradient LUT (straight colour; the LUT alpha is ignored).  uP0 = (reverse 0/1, amount 0..1, 0, 0)
// t = Rec.709 luma of the straight colour (1 - t when reversed); LUT index x = t * 255 with linear interpolation between entries.
void main() {
    vec4 c = fxSrc(fxPos());
    vec3 s = fxStraight(c);
    float t = clamp(fxLuma(s), 0.0, 1.0);
    if (uP0.x > 0.5) t = 1.0 - t;
    float x = t * 255.0;
    float fl = floor(x);
    int i0 = int(fl);
    int i1 = min(i0 + 1, 255);
    vec3 g = mix(fxData(i0, 0).rgb, fxData(i1, 0).rgb, x - fl);
    fxOut(fxPm(mix(s, g, uP0.y), c.a));
}
