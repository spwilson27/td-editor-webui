// Curves: input 2 = 256 x 1 RGBA8 LUT (texel i = (red curve, green curve, blue curve, 255) of the straight value i / 255, master applied
// first).  The straight colour is mapped through the LUT with linear interpolation between entries.  Alpha unchanged.
vec3 fxLut256(vec3 s) {
    vec3 x = clamp(s, 0.0, 1.0) * 255.0;
    vec3 fl = floor(x);
    vec3 w = x - fl;
    ivec3 i0 = ivec3(int(fl.r), int(fl.g), int(fl.b));
    ivec3 i1 = min(i0 + 1, ivec3(255));
    return vec3(mix(fxData(i0.r, 0).r, fxData(i1.r, 0).r, w.r),
                mix(fxData(i0.g, 0).g, fxData(i1.g, 0).g, w.g),
                mix(fxData(i0.b, 0).b, fxData(i1.b, 0).b, w.b));
}
void main() {
    vec4 c = fxSrc(fxPos());
    fxOut(fxPm(fxLut256(fxStraight(c)), c.a));
}
