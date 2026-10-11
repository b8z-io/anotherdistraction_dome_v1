#version 330
// Another Distraction — second pass: depth of field, then tonemap.
// Input (uSrc, mipmapped): linear HDR colour in rgb, blur amount in a (0 = in focus, 1 = softest,
// from how far that point is from the focus bubble — see lattice.frag).
//
// A pixel with blur b spreads into a disc b * uCocMax pixels across. Gathered with two
// spiral tap sets: one sized to this pixel's own blur, one at the largest blur so soft
// neighbours can spill their light over sharper pixels nearby.

out vec4 fragColor;

uniform sampler2D uSrc;
uniform vec2  uRes;
uniform float uCocMax;      // px for blur = 1; 0 = no depth of field
uniform int   uTaps;        // per tap set
uniform int   uMaskCircle;  // domemaster: black outside the circle
uniform float uExposure;
uniform float uMaster;
uniform float uSeed;

float hash31(vec3 p) {     // same as lattice.frag, so the dither matches
    p = fract(p * 0.1031 + uSeed * 0.0173);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
}

float coc(float b) { return clamp(b, 0.0, 1.0) * uCocMax; }

vec3 tonemap(vec3 x) {
    x *= uExposure;
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
    vec2 uv = gl_FragCoord.xy / uRes;
    if (uMaskCircle == 1 && length(uv * 2.0 - 1.0) > 1.0) { fragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    vec4 c = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0);
    vec3 col = c.rgb;
    if (uCocMax > 0.0 && uTaps > 0) {
        float cc = coc(c.a);
        vec3 sum = c.rgb;
        float tot = 1.0;
        float n = float(uTaps);
        for (int set = 0; set < 2; set++) {
            float R = set == 0 ? cc : uCocMax;
            if (R < 0.75) continue;                       // nothing to gather at this size
            float dr = R / sqrt(n);                       // spacing between taps
            float lod = max(log2(dr) + 1.0, 0.0);         // a pre-blurred level smooths between taps
            for (int i = 0; i < uTaps; i++) {
                float r = sqrt((float(i) + 0.5) / n) * R;
                float a = float(i) * 2.39996323 + float(set) * 1.3;
                vec4 s = textureLod(uSrc, uv + vec2(cos(a), sin(a)) * r / uRes, lod);
                float sc = coc(s.a);
                if (set == 1 && sc <= cc) continue;       // the wide set only adds blurrier neighbours
                float m = smoothstep(r - dr, r + dr, sc);
                sum += mix(sum / tot, s.rgb, m);
                tot += 1.0;
            }
        }
        col = sum / tot;
    }
    col = tonemap(col);
    col = pow(col, vec3(1.0 / 2.2));
    // deterministic dither against banding in dark gradients
    float dth = hash31(vec3(gl_FragCoord.xy, 7.0)) - 0.5;
    col += dth / 255.0 * min(uMaster * 4.0, 1.0);   // true black when the show is dark
    fragColor = vec4(col, 1.0);
}
