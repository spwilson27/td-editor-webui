// Channel mixer.  uP0 = (rr, rg, rb, gr), uP1 = (gg, gb, br, bg), uP2 = (bb, r, g, b), uP3 = (monochrome 0/1, grayRed, grayGreen, grayBlue); all /100.
// out = clamp(M * c + k);  monochrome: out = clamp(dot(gray, c)) on all three channels (matrix and constants ignored).
void main() {
    vec4 c = fxSrc(fxPos());
    vec3 s = fxStraight(c);
    vec3 o;
    if (uP3.x > 0.5) {
        o = vec3(dot(uP3.yzw, s));
    } else {
        o = vec3(dot(vec3(uP0.x, uP0.y, uP0.z), s) + uP2.y,
                 dot(vec3(uP0.w, uP1.x, uP1.y), s) + uP2.z,
                 dot(vec3(uP1.z, uP1.w, uP2.x), s) + uP2.w);
    }
    fxOut(fxPm(clamp(o, 0.0, 1.0), c.a));
}
