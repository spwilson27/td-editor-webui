// Tile / mirror.  uP0 = (tilesX, tilesY, mirror, edge), uP1 = (offsetX frac of tile, offsetY frac of tile, rotation rad, 0)
void main() {
    vec2 D = vec2(fxDocSize());
    vec2 p = vec2(fxDoc(fxPos())) + 0.5;
    vec2 n = uP0.xy;
    vec2 tile = D / n;
    vec2 C = 0.5 * D;
    float cs = fxCos(uP1.z), sn = fxSin(uP1.z);
    vec2 v = p - C;
    // grid rotated clockwise by rotation: bring the point into the grid's frame with the inverse rotation
    vec2 g = C + vec2(cs * v.x + sn * v.y, -sn * v.x + cs * v.y) - uP1.xy * tile;
    vec2 u = g / tile;
    vec2 i = floor(u);
    vec2 f = u - i;
    if (uP0.z > 0.5) {
        if (mod(i.x, 2.0) > 0.5) f.x = 1.0 - f.x;
        if (mod(i.y, 2.0) > 0.5) f.y = 1.0 - f.y;
    }
    fxOut(fxSampleDoc(f * D, int(uP0.w + 0.5)));
}
