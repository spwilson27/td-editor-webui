// Threshold.  uP0.x = level.  Rec.709 luma of the straight colour >= level -> white else black; alpha unchanged.
void main() {
    vec4 c = fxSrc(fxPos());
    float v = fxLuma(fxStraight(c)) >= uP0.x ? 1.0 : 0.0;
    fxOut(fxPm(vec3(v), c.a));
}
