// Chromatic Aberration.  1 pass.  Red is sampled at +offset, blue at -offset, green in place (bilinear), offset =
// amount px along `angle` (degrees, 0 = right, counter-clockwise on screen).  alpha = max of the three channel alphas.
//   uP0 = (offset x, offset y) in document px (y down) = amount * (cos a, -sin a)
void main() {
    ivec2 f = fxPos();
    vec2 q = vec2(f) + 0.5;
    vec2 o = uP0.xy;
    vec4 r = fxSrcLinear(q + o);
    vec4 g = fxSrcLinear(q);
    vec4 b = fxSrcLinear(q - o);
    fxOut(vec4(r.r, g.g, b.b, max(r.a, max(g.a, b.a))));
}
