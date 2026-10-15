// Feedback / echo trail frozen after n frames, 1 pass.  Layers i = 0..n-1: L_i(q) = in(T^-i(q)) * w_i, T = affine transform about centre c:
//   T(p) = c + s * R(theta) (p - c) + d      (R clockwise on screen, y down, d in px).   T^i(p) = c + s^i R(i theta) (p - c) + t_i,  t_i = s R t_{i-1} + d, t_0 = 0.
// The pixel is inverse-mapped into the input per layer and sampled bilinearly (edge transparent).  Opacity w_i = decay^i (fade 0, exp) or
// max(0, 1 - i (1 - decay)) (fade 1, linear).  Accumulation in PREMULTIPLIED maths, i = 0 (the untransformed input) first:
//   blend 0 over:    acc += (1 - acc.a) * L        (newer iterations BEHIND the older ones = exactly compositing the copies, input on top)
//   blend 1 add:     acc += L                       (clamped to alpha <= 1, rgb <= alpha at the end)
//   blend 2 lighten: acc = max(acc, L) per premultiplied channel (alpha = max alpha)
//   blend 3 screen:  acc = acc + L - acc * L per premultiplied channel
// Also used by the echo filter (translation only: cos = 1, sin = 0, s = 1).
//   uP0 = (n, dx, dy, cos theta)   uP1 = (sin theta, s, decay, blend)   uP2 = (centre x fraction, centre y fraction, fade, 0)
void main() {
    ivec2 f = fxPos();
    int n = int(uP0.x + 0.5);
    vec2 dd = vec2(uP0.y, uP0.z);
    float cr = uP0.w;
    float sr = uP1.x;
    float s = uP1.y;
    float decay = uP1.z;
    int blend = int(uP1.w + 0.5);
    int fade = int(uP2.z + 0.5);
    vec2 D = vec2(fxDocSize());
    vec2 c = vec2(uP2.x, uP2.y) * D;
    vec2 q = vec2(fxDoc(f)) + 0.5;
    vec4 acc = fxSrc(f);
    vec2 t = vec2(0.0);
    float sc = 1.0;
    vec2 rot = vec2(1.0, 0.0);
    float w = 1.0;
    for (int i = 1; i < 64; i++) {
        if (i >= n) break;
        t = s * vec2(cr * t.x - sr * t.y, sr * t.x + cr * t.y) + dd;
        sc *= s;
        rot = vec2(rot.x * cr - rot.y * sr, rot.x * sr + rot.y * cr);
        w = fade == 1 ? max(0.0, 1.0 - float(i) * (1.0 - decay)) : w * decay;
        if (w <= 0.0) break;
        vec2 u = q - c - t;
        vec2 p = vec2(rot.x * u.x + rot.y * u.y, -rot.y * u.x + rot.x * u.y) / sc + c;
        p = clamp(p, vec2(-4.0), D + 4.0);
        vec4 L = fxSampleDoc(p, 0) * w;
        if (blend == 0) acc += (1.0 - acc.a) * L;
        else if (blend == 1) acc += L;
        else if (blend == 2) acc = max(acc, L);
        else acc = acc + L - acc * L;
    }
    acc.a = clamp(acc.a, 0.0, 1.0);
    acc.rgb = clamp(acc.rgb, vec3(0.0), vec3(acc.a));
    fxOut(acc);
}
