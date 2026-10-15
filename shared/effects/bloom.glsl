// Bloom, final pass.  input 0 = the original (premultiplied), input 1 = the blurred bright pass (the "blur" passes before, premultiplied).
//   uP0 = (intensity (1 = 100 %), tint r, tint g, tint b)   uP1 = (tint a, 0, 0, 0)
// B.a = clamp(blur.a * intensity * tint.a, 0, 1), B.rgb = min(blur.rgb * tint.rgb * intensity * tint.a, B.a);
// premultiplied screen blend of the glow over the original: out = c + B - c * B on rgb AND alpha (alpha = union coverage 1-(1-a)(1-B.a),
// >= max(a, B.a); rgb <= alpha is preserved).
void main() {
    ivec2 f = fxPos();
    vec4 c = fxSrc(f);
    vec4 b = fxAux(f);
    float k = uP0.x * uP1.x;
    float ba = clamp(b.a * k, 0.0, 1.0);
    vec3 br = min(clamp(b.rgb * uP0.yzw * k, 0.0, 1.0), vec3(ba));
    fxOut(vec4(c.rgb + br - c.rgb * br, c.a + ba - c.a * ba));
}
