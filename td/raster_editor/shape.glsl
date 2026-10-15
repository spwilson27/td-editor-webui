// Raster Editor v3 shape layer (docs/DESIGN_V3.md 2.2 / 3).
// GLSL TOP pixel shader, NO inputs.  One node per shape layer (``shape_<id>``) at document resolution.
// Output: PREMULTIPLIED rgba (blend.glsl input 1 convention), transparent outside the shape.
//
// All geometry is in TD pixel coordinates: origin BOTTOM-left, y up, pixel centres at +0.5
// (network.shape_uniforms converts from the document's top-left / y-down coordinates).
//
// Uniforms (GLSL TOP "Vectors" page; same slot names as blend.glsl so a pooled node can serve both):
//   uParams  x = shape type (1 rect, 2 ellipse, 3 line, 4 polygon/star)
//            y = rotation about the centre as a mathematical angle in TD's y-up space (counter-clockwise
//                positive); a CLOCKWISE on-screen rotation of t degrees is therefore y = -radians(t)
//            z = fill enabled   w = stroke enabled
//   uOffset  rect/ellipse: xy = centre, zw = half width / half height (unrotated)
//            line:         xy = start, zw = end
//            polygon:      xy = centre, z = circumradius, w = innerRatio (>= 1 = regular polygon, else star)
//   uA       x = corner radius (rect, already clamped)   y = polygon sides (3..64)
//            z = stroke width px                          w = line arrows bit0 = start, bit1 = end
//   uB       fill colour   straight rgba 0..1
//   uC       stroke colour straight rgba 0..1
//
// Conventions: web/src/engine/textShape.ts (header comment).  Stroke is centred on the outline (half inside,
// half outside) with ROUND joins: the band |signedDistance| <= width / 2 (rect, ellipse, polygon, star).  Fill is
// painted first, the stroke over it.  Lines are stroke only: shaft with butt ends + arrowhead triangles drawn as one
// union in the stroke colour.  Arrowhead: length H = min(max(8, 4 w), both ends ? len/2 : len), half base width
// 0.4 H, tip on the end point; the shaft starts / stops H/2 inside the head.  A zero-length line draws nothing.
// Polygon vertex k (a star has 2n alternating outer / inner vertices) lies at 90deg - k * 360deg / count (TD space),
// i.e. vertex 0 points straight up on screen and the order is clockwise.  A polygon with innerRatio < 1 is a star.
// Antialiasing: coverage = clamp(0.5 - signedDistance, 0, 1); within 1.5 px of an edge 4x4 supersampled.

uniform vec4 uParams;
uniform vec4 uOffset;
uniform vec4 uA;
uniform vec4 uB;
uniform vec4 uC;

out vec4 fragColor;

const float PI = 3.14159265358979;

float cov(float d) { return clamp(0.5 - d, 0.0, 1.0); }

float sdRoundBox(vec2 p, vec2 h, float r) {
    r = min(r, min(h.x, h.y));
    vec2 q = abs(p) - h + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

// ellipse: exact signed distance (D. Eberly, "Distance from a Point to an Ellipse": bisection on the secular
// equation, robust for any eccentricity, no trigonometry, so no NaN at the centre or on the axes)
float eberlyRoot(float r0, float z0, float z1, float g) {
    float n0 = r0 * z0;
    float s0 = z1 - 1.0;
    float s1 = g < 0.0 ? 0.0 : length(vec2(n0, z1)) - 1.0;
    float s = 0.0;
    for (int i = 0; i < 48; i++) {
        s = 0.5 * (s0 + s1);
        if (s == s0 || s == s1) break;
        float ra = n0 / (s + r0);
        float rb = z1 / (s + 1.0);
        float gg = ra * ra + rb * rb - 1.0;
        if (gg > 0.0) s0 = s;
        else if (gg < 0.0) s1 = s;
        else break;
    }
    return s;
}

// margin: distances beyond it are only needed as a lower bound (cheap shortcuts); stroke half width + 3
float sdEllipse(vec2 p, vec2 r, float margin) {
    r = max(r, vec2(1e-3));
    vec2 q = abs(p);
    // inside the inscribed circle every point is at least (min(r) - |p|) from the outline
    float rm = min(r.x, r.y);
    if (length(q) < rm - margin) return length(q) - rm;
    // outside the bounding box by > margin: the distance to the box is a lower bound that is good enough
    if (q.x > r.x + margin || q.y > r.y + margin) return length(max(q - r, 0.0));
    bool sw = r.x < r.y;                 // algorithm wants e0 >= e1
    vec2 e = sw ? r.yx : r.xy;
    vec2 y = sw ? q.yx : q.xy;
    float dist, x0, x1;
    if (y.y > 0.0) {
        if (y.x > 0.0) {
            vec2 z = y / e;
            float g = dot(z, z) - 1.0;
            if (abs(g) < 1e-9) {
                dist = 0.0;
            } else {
                float r0 = (e.x / e.y) * (e.x / e.y);
                float sb = eberlyRoot(r0, z.x, z.y, g);
                x0 = r0 * y.x / (sb + r0);
                x1 = y.y / (sb + 1.0);
                dist = length(vec2(x0 - y.x, x1 - y.y));
            }
        } else {
            dist = abs(y.y - e.y);
        }
    } else {
        float numer0 = e.x * y.x;
        float denom0 = e.x * e.x - e.y * e.y;
        if (numer0 < denom0) {
            float xde0 = numer0 / denom0;
            x0 = e.x * xde0;
            x1 = e.y * sqrt(max(0.0, 1.0 - xde0 * xde0));
            dist = length(vec2(x0 - y.x, x1));
        } else {
            dist = abs(y.x - e.x);
        }
    }
    vec2 k = q / r;
    return dot(k, k) < 1.0 ? -dist : dist;
}

float sdSegment(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-12), 0.0, 1.0);
    return length(pa - ba * h);
}

float sdTriangle(vec2 p, vec2 a, vec2 b, vec2 c) {
    vec2 e0 = b - a, e1 = c - b, e2 = a - c;
    vec2 v0 = p - a, v1 = p - b, v2 = p - c;
    vec2 pq0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0.0, 1.0);
    vec2 pq1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);
    vec2 pq2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);
    float s = sign(e0.x * e2.y - e0.y * e2.x);
    vec2 d = min(min(vec2(dot(pq0, pq0), s * (v0.x * e0.y - v0.y * e0.x)),
                     vec2(dot(pq1, pq1), s * (v1.x * e1.y - v1.y * e1.x))),
                 vec2(dot(pq2, pq2), s * (v2.x * e2.y - v2.y * e2.x)));
    return -sqrt(d.x) * sign(d.y);
}

// oriented box between a and b (butt caps), half width hw
float sdBody(vec2 p, vec2 a, vec2 b, float hw) {
    vec2 ba = b - a;
    float l = length(ba);
    if (l < 1e-6) return 1e5;
    vec2 u = ba / l;
    vec2 q = p - (a + b) * 0.5;
    q = vec2(dot(q, u), dot(q, vec2(-u.y, u.x)));
    return sdRoundBox(q, vec2(l * 0.5, hw), 0.0);
}

vec2 polyVertex(int k, int n, float R, float inner, bool star) {
    float steps = star ? float(2 * n) : float(n);
    float a = PI * 0.5 - float(k) * 2.0 * PI / steps;
    float r = (star && (k & 1) == 1) ? R * inner : R;
    return vec2(cos(a), sin(a)) * r;
}

float sdPolygon(vec2 p, int n, float R, float inner, bool star) {
    int m = star ? 2 * n : n;
    vec2 v0 = polyVertex(0, n, R, inner, star);
    vec2 prev = v0;
    float d = dot(p - v0, p - v0);
    float s = 1.0;
    for (int i = 1; i <= m; i++) {
        vec2 cur = (i == m) ? v0 : polyVertex(i, n, R, inner, star);
        vec2 e = prev - cur;
        vec2 w = p - cur;
        vec2 b = w - e * clamp(dot(w, e) / dot(e, e), 0.0, 1.0);
        d = min(d, dot(b, b));
        bvec3 c = bvec3(p.y >= cur.y, p.y < prev.y, e.x * w.y > e.y * w.x);
        if (all(c) || all(not(c))) s = -s;
        prev = cur;
    }
    return s * sqrt(d);
}

// signed distances (negative inside) of the fill region and of the stroke region at TD pixel position q
vec2 field(vec2 q) {
    int type = int(uParams.x + 0.5);
    bool fillOn = uParams.z > 0.5;
    float sw = uA.z;
    bool strokeOn = uParams.w > 0.5 && (sw > 0.0 || type == 3);
    float cr = cos(uParams.y), sr = sin(uParams.y);
    float fd = 1e5, sd = 1e5;
    if (type == 3) {
        vec2 a = uOffset.xy, b = uOffset.zw;
        vec2 ba = b - a;
        float len = length(ba);
        if (strokeOn && len > 1e-6) {
            bool arrowS = mod(uA.w, 2.0) >= 1.0;
            bool arrowE = uA.w >= 2.0;
            vec2 u = ba / len;
            vec2 n = vec2(-u.y, u.x);
            float H = min(max(8.0, 4.0 * sw), (arrowS && arrowE) ? len * 0.5 : len);
            float hwid = 0.4 * H;
            float t0 = arrowS ? H * 0.5 : 0.0;
            float t1 = len - (arrowE ? H * 0.5 : 0.0);
            if (sw > 0.0 && t1 > t0) sd = sdBody(q, a + u * t0, a + u * t1, 0.5 * sw);
            if (arrowE) sd = min(sd, sdTriangle(q, b, b - u * H + n * hwid, b - u * H - n * hwid));
            if (arrowS) sd = min(sd, sdTriangle(q, a, a + u * H + n * hwid, a + u * H - n * hwid));
        }
        return vec2(fd, sd);
    }
    vec2 dv = q - uOffset.xy;
    vec2 l = vec2(cr * dv.x + sr * dv.y, -sr * dv.x + cr * dv.y);   // rotate by -rotation
    float d = 1e5;
    if (type == 1) d = sdRoundBox(l, uOffset.zw, uA.x);
    else if (type == 2) d = sdEllipse(l, uOffset.zw, 0.5 * sw + 3.0);
    else if (type == 4) {
        float R = uOffset.z;
        d = length(l) - R;
        if (R < 1e-3) d = 1e5;                    // degenerate polygon: nothing to draw
        else if (d <= sw + 2.0) {
            int n = clamp(int(uA.y + 0.5), 3, 64);
            d = sdPolygon(l, n, R, uOffset.w, uOffset.w < 1.0);
        }
    }
    if (fillOn) fd = d;
    if (strokeOn) sd = abs(d) - 0.5 * sw;
    return vec2(fd, sd);
}

void main() {
    vec2 p = gl_FragCoord.xy;
    vec2 d0 = field(p);
    vec2 c;
    if (min(abs(d0.x), abs(d0.y)) < 1.5) {
        // edge band: 4x4 supersampling of the (locally 1/4 px wide) distance ramps -> area coverage, also at
        // sharp tips where the plain distance ramp under-estimates the browser's coverage
        c = vec2(0.0);
        for (int j = 0; j < 4; j++) {
            for (int i = 0; i < 4; i++) {
                vec2 d = field(p + (vec2(float(i), float(j)) - 1.5) * 0.25);
                c += clamp(0.5 - d * 4.0, 0.0, 1.0);
            }
        }
        c /= 16.0;
    } else {
        c = clamp(0.5 - d0, 0.0, 1.0);
    }
    float fa = uB.a * c.x;
    float sa = uC.a * c.y;
    vec3 rgb = uC.rgb * sa + uB.rgb * fa * (1.0 - sa);
    float a = sa + fa * (1.0 - sa);
    fragColor = TDOutputSwizzle(vec4(rgb, a));
}
