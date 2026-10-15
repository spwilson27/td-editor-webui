// Invert: straight colour -> 1 - c, alpha unchanged.
void main() {
    vec4 c = fxSrc(fxPos());
    fxOut(fxPm(1.0 - fxStraight(c), c.a));
}
