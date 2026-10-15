// Colour balance.  uP0 = (sh cyanRed, sh magentaGreen, sh yellowBlue, mid cyanRed), uP1 = (mid magentaGreen, mid yellowBlue, hi cyanRed,
// hi magentaGreen), uP2 = (hi yellowBlue, preserveLuminosity 0/1, 0, 0); shifts are already /100.
// L = Rec.709 luma of the straight colour.  Tonal weights (sum to 1):  shadows ws = (1-L)^2,  highlights wh = L^2,  midtones wm = 2 L (1-L).
// shift = 0.5 * (ws * sh + wm * mid + wh * hi) per channel (R = cyan-red, G = magenta-green, B = yellow-blue);  out = clamp(c + shift).
// preserveLuminosity: out += L(c) - L(out) on all channels, then clamp.
void main() {
    vec4 c = fxSrc(fxPos());
    vec3 s = fxStraight(c);
    float l = clamp(fxLuma(s), 0.0, 1.0);
    float ws = (1.0 - l) * (1.0 - l);
    float wh = l * l;
    float wm = 2.0 * l * (1.0 - l);
    vec3 sh = uP0.xyz;
    vec3 mi = vec3(uP0.w, uP1.x, uP1.y);
    vec3 hi = vec3(uP1.z, uP1.w, uP2.x);
    vec3 o = clamp(s + 0.5 * (ws * sh + wm * mi + wh * hi), 0.0, 1.0);
    if (uP2.y > 0.5) o = clamp(o + (fxLuma(s) - fxLuma(o)), 0.0, 1.0);
    fxOut(fxPm(o, c.a));
}
