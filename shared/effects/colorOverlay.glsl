// Colour Overlay.  1 pass.  uP0 = colour (straight rgb 0..1, a = colour alpha * opacity).
// Replaces the colour of the layer content by mix(content, colour, a), alpha unchanged:
//   out = C * (1 - a) + rgb * a * A      (C premultiplied content, A its alpha)
void main() {
    ivec2 f = fxPos();
    vec4 c = fxSrc(f);
    float k = clamp(uP0.a, 0.0, 1.0);
    fxOut(vec4(c.rgb * (1.0 - k) + uP0.rgb * k * c.a, c.a));
}
