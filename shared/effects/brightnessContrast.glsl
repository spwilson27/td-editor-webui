// Brightness / contrast.  uP0 = (brightness -1..1, contrast -1..1, 0, 0).   Same maths as the v2 adjustment.
//   c1 = clamp(c * (1 + brightness)); out = clamp((c1 - 0.5) * (1 + contrast) + 0.5)
void main() {
    vec4 c = fxSrc(fxPos());
    vec3 s = fxStraight(c);
    vec3 c1 = clamp(s * (1.0 + uP0.x), 0.0, 1.0);
    fxOut(fxPm(clamp((c1 - 0.5) * (1.0 + uP0.y) + 0.5, 0.0, 1.0), c.a));
}
