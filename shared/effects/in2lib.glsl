// Input 2 helpers, appended after filterlib.glsl for shaders whose filter spec says "in2": true (see filterlib.glsl).

vec4 fxData(int x, int y) { return texelFetch(sTD2DInputs[2], ivec2(x, y), 0); }
vec4 fxAux2(ivec2 f) {
    if (!fxIn(f, fxSize())) return vec4(0.0);
    return texelFetch(sTD2DInputs[2], ivec2(f.x, fxTexSize().y - 1 - f.y), 0);
}

