// High-pass, final pass.  input 0 = original, input 1 = gaussian blur of it (absent / identical when radius = 0 -> flat grey).
//   uP0 = (1 when a blur ran, 0, 0, 0)
void main() {
    ivec2 f = fxPos();
    vec4 s = fxSrc(f);
    vec4 b = uP0.x > 0.5 ? fxAux(f) : s;
    vec3 ss = fxStraight(s);
    vec3 bs = fxStraight(b);
    vec3 o = clamp(0.5 + (ss - bs), 0.0, 1.0);
    fxOut(vec4(o * s.a, s.a));
}
