// Posterize: straight colour channel c -> floor(c * (n - 1) + 0.5) / (n - 1).   uP0 = (n levels >= 2, 0, 0, 0)
// The straight 8-bit value comes from an exact integer unpremultiply (fxStraightI), so the rounding decision cannot flip between GPUs.
void main() {
    vec4 c = fxSrc(fxPos());
    float k = max(uP0.x - 1.0, 1.0);
    vec3 s = vec3(fxStraightI(c)) / 255.0;
    fxOut(fxPm(floor(s * k + 0.5) / k, c.a));
}
