// Hue / saturation / value (true HSV edit, == the v2 adjustment).  uP0 = (hue deg, saturation x, value x, 0).
vec3 hsRgb2Hsv(vec3 c) {
    float mx = max(max(c.r, c.g), c.b), mn = min(min(c.r, c.g), c.b), d = mx - mn;
    float h = 0.0;
    if (d > 0.0) {
        if (mx == c.r) h = mod((c.g - c.b) / d, 6.0);
        else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
        else h = (c.r - c.g) / d + 4.0;
    }
    return vec3(h * 60.0, mx > 0.0 ? d / mx : 0.0, mx);
}

vec3 hsHsv2Rgb(vec3 c) {
    float h6 = mod(c.x, 360.0) / 60.0;
    float i = floor(h6), f = h6 - i;
    float p = c.z * (1.0 - c.y), q = c.z * (1.0 - c.y * f), t = c.z * (1.0 - c.y * (1.0 - f));
    int k = int(i) % 6;
    if (k == 0) return vec3(c.z, t, p);
    if (k == 1) return vec3(q, c.z, p);
    if (k == 2) return vec3(p, c.z, t);
    if (k == 3) return vec3(p, q, c.z);
    if (k == 4) return vec3(t, p, c.z);
    return vec3(c.z, p, q);
}

void main() {
    vec4 c = fxSrc(fxPos());
    vec3 h = hsRgb2Hsv(fxStraight(c));
    vec3 o = hsHsv2Rgb(vec3(h.x + uP0.x, min(1.0, h.y * uP0.y), h.z * uP0.z));
    fxOut(fxPm(clamp(o, 0.0, 1.0), c.a));
}
