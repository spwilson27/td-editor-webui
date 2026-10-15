// Unsharp mask, final pass.  input 0 = the original, input 1 = its gaussian blur (the "blur" passes before this one).
//   uP0 = (amount (1 = 100 %), threshold 0..1, 0, 0);  the threshold is a linear ramp 0..1 over +-1 level (1/255) around it
void main() {
    ivec2 f = fxPos();
    vec4 s = fxSrc(f);
    vec4 b = fxAux(f);
    vec3 d = s.rgb - b.rgb;
    // threshold: soft ramp of +-1 level around it (a hard compare of values that differ by f16 / GPU rounding would flip whole pixels)
    vec3 k = clamp((abs(d) - uP0.y) * 255.0 * 0.5 + 0.5, 0.0, 1.0);
    if (uP0.y <= 0.0) k = vec3(1.0);
    vec3 o = s.rgb + uP0.x * d * k;
    fxOut(vec4(clamp(o, 0.0, s.a), s.a));
}
