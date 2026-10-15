// Emboss.  uP0 = (Lx, Ly, height px, amount (1 = 100 %))   uP1 = (mode 0 gray | 1 overlay, 0, 0, 0)
// L = unit vector TOWARDS the light in document axes (y down); angle 0 = light from the right, counter-clockwise on screen (as bevel).
// relief = (luma(p - L*h) - luma(p + L*h)) * amount: positive on slopes that rise away from the light (= lit slopes).  Luma of the
// PREMULTIPLIED colour (transparent = height 0), taps bilinear at the continuous positions p +- L*h.
// gray: straight colour = 0.5 + relief; overlay: straight colour = original + relief.  Alpha unchanged.
void main() {
    ivec2 f = fxPos();
    vec4 c = fxSrc(f);
    vec2 q = vec2(f) + 0.5;
    vec2 d = uP0.xy * uP0.z;
    float rel = (fxLuma(fxSrcLinear(q - d).rgb) - fxLuma(fxSrcLinear(q + d).rgb)) * uP0.w;
    vec3 s = fxStraight(c);
    vec3 o = uP1.x > 0.5 ? s + rel : vec3(0.5 + rel);
    fxOut(fxPm(clamp(o, 0.0, 1.0), c.a));
}
