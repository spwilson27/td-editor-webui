// Duotone / tritone.  uP0 = (shadow rgb, highlight r), uP1 = (highlight g, highlight b, mid r, mid g), uP2 = (mid b, useMid 0/1, k, amount 0..1).
// t = clamp((luma - 0.5) * k + 0.5);  two colours: mix(shadow, highlight, t);  three: t < 0.5 ? mix(shadow, mid, 2t) : mix(mid, highlight, 2t - 1).
void main() {
    vec4 c = fxSrc(fxPos());
    vec3 s = fxStraight(c);
    vec3 sh = uP0.xyz;
    vec3 hi = vec3(uP0.w, uP1.x, uP1.y);
    vec3 mi = vec3(uP1.z, uP1.w, uP2.x);
    float t = clamp((fxLuma(s) - 0.5) * uP2.z + 0.5, 0.0, 1.0);
    vec3 d;
    if (uP2.y > 0.5) d = t < 0.5 ? mix(sh, mi, 2.0 * t) : mix(mi, hi, 2.0 * t - 1.0);
    else d = mix(sh, hi, t);
    fxOut(fxPm(mix(s, d, uP2.w), c.a));
}
