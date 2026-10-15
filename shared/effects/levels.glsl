// Levels.  uP0 = (inLow, inHigh (>= inLow + 1e-4), gamma, outLow), uP1.x = outHigh.   Same maths as the v2 levels adjustment.
// t = clamp((c - inLow) / (inHigh - inLow)); out = outLow + (outHigh - outLow) * t^(1/gamma), on straight colour, alpha unchanged.
void main() {
    vec4 c = fxSrc(fxPos());
    vec3 s = fxStraight(c);
    vec3 t = clamp((s - uP0.x) / (uP0.y - uP0.x), 0.0, 1.0);
    vec3 o = uP0.w + (uP1.x - uP0.w) * pow(t, vec3(1.0 / uP0.z));
    fxOut(fxPm(clamp(o, 0.0, 1.0), c.a));
}
