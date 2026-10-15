// Halftone (experimental).  1 pass.  A square grid of `cellSize` px, rotated by `angle` degrees (clockwise on screen) about the
// document origin.  Per cell the alpha-weighted mean colour and mean alpha of 4x4 sample points are measured (so the result does not
// depend on which pixel of the cell is looked at); ink coverage f = 1 - luma(mean colour) (dark -> big dots); the cell is redrawn
// as a dot (area-correct radius, merging to full coverage) or a line (stripe parallel to the rotated x axis, width f * cell) of
// the mean colour with alpha = mean alpha * anti-aliased coverage.  Bright areas therefore thin out (ink-on-paper look).
//   uP0 = (cellSize, cos(angle), sin(angle), shape 0 dot / 1 line)
void main() {
    ivec2 f = fxPos();
    vec2 p = vec2(fxDoc(f)) + 0.5;                         // document position of the pixel centre
    float cs = max(uP0.x, 1.0);
    vec2 cx = vec2(uP0.y, uP0.z);                          // image of the grid x axis (y down: clockwise on screen)
    vec2 cy = vec2(-uP0.z, uP0.y);
    vec2 u = vec2(dot(p, cx), dot(p, cy)) / cs;            // grid coordinates (cells)
    vec2 cell = floor(u);
    vec2 local = (u - cell - 0.5) * cs;                    // px from the cell centre in grid axes
    vec3 sum = vec3(0.0);
    float asum = 0.0;
    vec2 org = vec2(fxDoc(ivec2(0, 0)));
    for (int j = 0; j < 4; j++) {
        for (int i = 0; i < 4; i++) {
            vec2 g = (cell + (vec2(float(i), float(j)) + 0.5) * 0.25) * cs;      // grid space, px
            vec2 dp = g.x * cx + g.y * cy;                                        // document position
            vec2 fp = floor(dp - org);
            vec4 s = fxSrc(ivec2(int(fp.x), int(fp.y)));
            sum += s.rgb;
            asum += s.a;
        }
    }
    float a = asum / 16.0;
    if (a <= 1e-5) { fxOut(vec4(0.0)); return; }
    vec3 col = clamp(sum / max(asum, 1e-6), 0.0, 1.0);        // mean straight colour (alpha weighted)
    float ink = 1.0 - fxLuma(col);
    float cov = 0.0;
    if (ink >= 0.995) {
        cov = 1.0;
    } else if (ink > 0.002) {
        // sub-pixel marks fade out with their size (no half-covered specks on white): the AA ramp is scaled by min(1, 2 * size)
        if (uP0.w > 0.5) {
            float hw = 0.5 * ink * cs;
            cov = clamp(hw - abs(local.y) + 0.5, 0.0, 1.0) * min(1.0, 2.0 * hw);
        } else {
            float r = ink < 0.7854 ? cs * sqrt(ink / FX_PI) : cs * mix(0.5, 0.7071, (ink - 0.7854) / 0.2146);
            cov = clamp(r - length(local) + 0.5, 0.0, 1.0) * min(1.0, 2.0 * r);
        }
    }
    float oa = a * cov;
    fxOut(vec4(col * oa, oa));
}
