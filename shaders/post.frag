#version 330
// Another Distraction — second pass: depth of field, then tonemap.
// Input (uSrc, mipmapped): linear HDR colour in rgb, focus distance in a (0 = inside the focus
// radius around the blob, 1 = at or beyond the end of the falloff — see lattice.frag).
//
// That distance is eased (squared) into a blur amount, so things just outside the focus radius get
// only a whisper of softness and the blur builds gently further out. A pixel with blur amount b is a
// soft Gaussian b * uCocMax pixels across (no hard bokeh discs, which turn thin struts into doubled
// lines). Gathered with two spirals, rotated per pixel so sparse taps read as fine grain rather than
// ghost copies: one sized to this pixel's own blur, one wide so soft neighbours spill gently over
// sharper pixels. Out-of-focus areas can also dim a little (uDim) to steer the eye.

out vec4 fragColor;

uniform sampler2D uSrc;
uniform vec2  uRes;
uniform float uCocMax;      // px for blur = 1; 0 = no depth of field
uniform int   uTaps;        // per tap set (at least 32)
uniform float uDim;         // how much the fully out-of-focus parts dim, 0..1
uniform int   uMaskCircle;  // domemaster: black outside the circle
uniform float uExposure;
uniform float uMaster;
uniform float uSeed;

float hash31(vec3 p) {     // same as lattice.frag, so the dither matches
    p = fract(p * 0.1031 + uSeed * 0.0173);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
}

float amount(float b) { b = clamp(b, 0.0, 1.0); return b * b; }   // gentle start just outside the radius
float coc(float b) { return amount(b) * uCocMax; }

vec3 tonemap(vec3 x) {
    x *= uExposure;
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
    vec2 uv = gl_FragCoord.xy / uRes;
    if (uMaskCircle == 1 && length(uv * 2.0 - 1.0) > 1.0) { fragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    vec4 c = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0);
    vec3 col = c.rgb;
    if (uCocMax > 0.0) {
        float cc = coc(c.a);
        vec3 sum = c.rgb;
        float tot = 1.0;
        int taps = clamp(uTaps, 32, 128);
        float n = float(taps);
        float spin = hash31(vec3(gl_FragCoord.xy, 3.0)) * 6.2831853;
        for (int set = 0; set < 2; set++) {
            float R = set == 0 ? cc : uCocMax;
            if (R < 0.6) continue;                        // nothing to gather at this size
            float dr = R / sqrt(n);                       // spacing between taps
            float lod = max(log2(dr), 0.0);               // a pre-blurred level fills the gaps between taps
            for (int i = 0; i < taps; i++) {
                float r = sqrt((float(i) + 0.5) / n) * R;
                float a = float(i) * 2.39996323 + spin + float(set) * 1.3;
                vec4 s = textureLod(uSrc, uv + vec2(cos(a), sin(a)) * r / uRes, lod);
                float w;
                if (set == 0) w = exp(-2.0 * (r / max(cc, 1e-3)) * (r / max(cc, 1e-3)));   // this pixel's own soft blur
                else {                                    // a softer neighbour spilling over a sharper pixel
                    float sc = coc(s.a);
                    if (sc <= cc + 0.5 || r > sc) continue;
                    w = 0.5 * exp(-2.0 * (r / sc) * (r / sc));
                }
                sum += s.rgb * w;
                tot += w;
            }
        }
        col = sum / tot;
    }
    col *= 1.0 - uDim * amount(c.a);
    col = tonemap(col);
    col = pow(col, vec3(1.0 / 2.2));
    // deterministic dither against banding in dark gradients
    float dth = hash31(vec3(gl_FragCoord.xy, 7.0)) - 0.5;
    col += dth / 255.0 * min(uMaster * 4.0, 1.0);   // true black when the show is dark
    fragColor = vec4(col, 1.0);
}
