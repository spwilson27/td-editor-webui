// Gaussian blur of the premultiplied rgba layer (filter "blur"; also the building block of unsharp mask, high-pass, bloom, lens blur).
//   uP0 = (sigma, radius R px, field mode (2 = rgba, 3 = bright pass), level L)    uP1 = (threshold, knee, 0, 0)
// L = 0 (radius <= 16): pass 0 = horizontal, pass 1 = vertical, full resolution, exact gaussian (sigma = radius / 3).
// L > 0 (pyramid, blurlib.glsl; sigma / R are the LOW-RES values): 2 = down, 3 = H, 4 = V (level L), 5 = up -> blurred full-res rgba.
// The bright pass (mode 3) is applied to the SOURCE samples (pass 0 / down), later passes see the already filtered field.
void main() {
    ivec2 f = fxPos();
    int pid = fxPass();
    int R = int(uP0.y + 0.5);
    float sg = uP0.x;
    int mode = int(uP0.z + 0.5);
    int L = int(uP0.w + 0.5);
    vec2 br = uP1.xy;
    vec4 z = vec4(0.0);
    if (pid == 2) { fxOut(fxDownBox(mode, L, ivec2(0), br)); return; }
    if (pid == 3) { fxOut(fxLowBlur(true, sg, R, L, z)); return; }
    if (pid == 4) { fxOut(fxLowBlur(false, sg, R, L, z)); return; }
    if (pid == 5) { fxOut(fxUp(f, L, z)); return; }
    // full resolution H (pass 0, from the source with the bright pass) / V (pass 1, from the previous pass): weights by recurrence (see blurlib.glsl)
    ivec2 st = pid == 0 ? ivec2(1, 0) : ivec2(0, 1);
    vec4 acc;
    if (pid == 0) acc = fxFieldOf(mode, fxSrc(f), br);
    else acc = fxAux(f);
    float ws = 1.0;
    float c = sg > 1e-4 ? exp(-0.5 / (sg * sg)) : 0.0;
    float c2 = c * c;
    float d = c;
    float w = 1.0;
    for (int i = 1; i <= R; i++) {
        w *= d;
        d *= c2;
        vec4 a = pid == 0 ? fxFieldOf(mode, fxSrc(f + st * i), br) : fxAux(f + st * i);
        vec4 b = pid == 0 ? fxFieldOf(mode, fxSrc(f - st * i), br) : fxAux(f - st * i);
        acc += w * (a + b);
        ws += 2.0 * w;
    }
    fxOut(acc / ws);
}
