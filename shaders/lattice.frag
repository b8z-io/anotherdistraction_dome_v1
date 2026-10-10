#version 330
// Another Distraction — section 1 "Seed"
// Stateless: every pixel is a pure function of (uTime, params, seed).
// Renders straight into a 180° equidistant (azimuthal) fisheye domemaster,
// or an equirectangular frame for VR-headset preview.

out vec4 fragColor;

uniform vec2  uRes;
uniform float uTime;
uniform int   uProj;        // 0 = domemaster, 1 = equirectangular
uniform float uFov;         // fisheye field of view, degrees (180 = hemisphere)
uniform float uTilt;        // dome tilt, degrees (tips zenith toward front)
uniform int   uSS;          // supersampling per axis

uniform float uSeed;
uniform mat3  uLatRot;      // world -> lattice rotation
uniform float uCell;        // lattice cell size
uniform float uStrutR;
uniform float uNodeR;
uniform sampler3D uGraph;   // growth graph from lattice.py (r=path dist, g=edge bits, b=cross-link bits)
uniform int   uGridH;       // grid half-size in cells
uniform float uExtent;      // lattice bounding radius (lattice space)
uniform vec3  uSeedPos;     // world-space seed point (= root node)
uniform float uFront;       // growth front, in path-distance units
uniform float uXDelay;      // cross-links appear this far behind the front

uniform vec3  uColDeep;
uniform vec3  uColStrut;
uniform vec3  uColTip;
uniform float uGlow;
uniform float uGlowW;
uniform float uTipGlow;
uniform float uFogDist;
uniform float uStar;        // seed-star intensity (from envelope)
uniform float uStarSize;    // radians
uniform float uExposure;
uniform int   uSteps;
uniform float uFar;

const float PI = 3.14159265359;

float hash31(vec3 p) {
    p = fract(p * 0.1031 + uSeed * 0.0173);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
}

vec3 seedL;  // seed in lattice space

vec3 cellData(vec3 id) {
    ivec3 g = ivec3(id) + uGridH;
    if (any(lessThan(g, ivec3(0))) || any(greaterThan(g, ivec3(2 * uGridH)))) return vec3(-1.0, 0.0, 0.0);
    return texelFetch(uGraph, g, 0).rgb;
}

bool bit(float mask, int k) { return (int(mask) >> k & 1) == 1; }

float sdSeg(vec3 p, vec3 a, vec3 b) {
    vec3 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
    return length(pa - ba * h);
}

vec3 dirOf(int k) {
    // order: +x -x +y -y +z -z  (opposite of k is k ^ 1)
    float sg = (k % 2 == 0) ? 1.0 : -1.0;
    int a = k / 2;
    return vec3(a == 0, a == 1, a == 2) * sg;
}

// returns distance; tip = growth-tip proximity glow
float sdLattice(vec3 p, out float tip) {
    float c = uCell;
    vec3 id = floor(p / c + 0.5);
    vec3 q = p - id * c;
    vec3 me = cellData(id);
    tip = 0.0;
    float dn = me.r;
    if (dn < 0.0) return 0.5 * c;          // empty site: nothing in this cell
    float d = 1e9;

    if (uFront > dn) {
        float grow = smoothstep(0.0, 0.6 * c, uFront - dn);
        d = length(q) - uNodeR * grow;
    }

    for (int k = 0; k < 6; k++) {
        if (!bit(me.g, k)) continue;
        vec3 dir = dirOf(k);
        float dm = cellData(id + dir).r;
        float lo = min(dn, dm), hi = max(dn, dm);
        if (bit(me.b, k)) { lo = hi + uXDelay; hi = lo + c; }   // cross-link: late, bridges two grown nodes
        float span = max(hi - lo, 1e-3);
        float e = clamp((uFront - lo) / span, 0.0, 1.0) * c; // grown length from the earlier end
        if (e <= 0.0) continue;
        float s0, s1;
        vec3 tipPos;
        if (dn <= dm) { s0 = 0.0; s1 = e; tipPos = dir * e; }
        else          { s0 = c - e; s1 = c; tipPos = dir * (c - e); }
        float a0 = clamp(s0, 0.0, 0.5 * c);
        float a1 = clamp(s1, 0.0, 0.5 * c);
        if (a1 > a0) d = min(d, sdSeg(q, dir * a0, dir * a1) - uStrutR);
        if (e < c) tip = max(tip, exp(-length(q - tipPos) / (uStrutR * 6.0)));
    }
    return min(d, 0.5 * c);
}

vec3 viewDir(vec2 frag) {
    vec2 uv = frag / uRes;
    if (uProj == 1) {
        float lon = (uv.x - 0.5) * 2.0 * PI;
        float lat = (uv.y - 0.5) * PI;
        return vec3(cos(lat) * sin(lon), sin(lat), -cos(lat) * cos(lon));
    }
    vec2 p = uv * 2.0 - 1.0;          // [-1,1], y up
    float r = length(p);
    if (r > 1.0) return vec3(0.0);
    float theta = r * radians(uFov) * 0.5;
    vec2 a = r > 1e-6 ? p / r : vec2(0.0);
    // bottom of frame = front (-z), right of frame = audience right (+x)
    vec3 d = vec3(a.x * sin(theta), cos(theta), a.y * sin(theta));
    float tl = radians(uTilt);
    // tilt about x: zenith tips toward front
    d = vec3(d.x, d.y * cos(tl) - d.z * sin(tl), d.y * sin(tl) + d.z * cos(tl));
    return normalize(d);
}

vec3 shade(vec3 rd) {
    vec3 col = vec3(0.0);

    // seed star
    float ang = acos(clamp(dot(rd, normalize(uSeedPos)), -1.0, 1.0));
    col += uColTip * uStar * (exp(-pow(ang / uStarSize, 2.0)) + 0.25 * exp(-ang / (uStarSize * 6.0)));

    if (uFront <= 0.0) return col;

    vec3 ro = uLatRot * vec3(0.0);
    vec3 rl = uLatRot * rd;
    float t = 0.05;
    float glow = 0.0, tipg = 0.0;
    vec3 hitCol = vec3(0.0);
    for (int i = 0; i < uSteps; i++) {
        vec3 p = ro + rl * t;
        float tip;
        float d = sdLattice(p, tip);
        float fog = exp(-t / uFogDist);
        if (d < 0.49 * uCell) glow += fog / (1.0 + pow(max(d, 0.0) / uGlowW, 2.0));  // occupied cells only: keep the sky black
        tipg += fog * tip;
        if (d < 0.0008 * t) {
            float edge = 1.0;
            vec3 base = mix(uColDeep * 2.5, uColStrut, fog);
            hitCol = mix(base, uColTip, clamp(tip * 1.5, 0.0, 1.0)) * mix(0.35, 1.0, fog) * edge;
            break;
        }
        // don't step past the current cell: neighbours aren't in the SDF
        vec3 q = p - floor(p / uCell + 0.5) * uCell;
        vec3 inv = 1.0 / max(abs(rl), vec3(1e-5));
        vec3 te = (0.5 * uCell - q * sign(rl)) * inv;
        float tExit = min(te.x, min(te.y, te.z)) + 0.002;
        t += max(min(d * 0.9, tExit), 0.0015);
        if (t > uFar || length(p) > uExtent + uCell) break;
    }
    col += hitCol;
    col += uColDeep * glow * uGlow * 0.02;
    col += uColTip * tipg * uTipGlow * 0.02;
    return col;
}

vec3 tonemap(vec3 x) {
    // ACES fitted (Narkowicz)
    x *= uExposure;
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
    seedL = uLatRot * uSeedPos;
    vec3 acc = vec3(0.0);
    int n = 0;
    for (int sy = 0; sy < uSS; sy++)
    for (int sx = 0; sx < uSS; sx++) {
        vec2 off = (vec2(sx, sy) + 0.5) / float(uSS);
        vec3 rd = viewDir(gl_FragCoord.xy - 0.5 + off);
        if (dot(rd, rd) < 0.5) continue;  // outside the dome circle
        acc += shade(rd);
        n++;
    }
    vec3 col = n > 0 ? acc / float(uSS * uSS) : vec3(0.0);
    col = tonemap(col);
    col = pow(col, vec3(1.0 / 2.2));
    // deterministic dither against banding in dark gradients
    float dth = hash31(vec3(gl_FragCoord.xy, 7.0)) - 0.5;
    col += dth / 255.0;
    fragColor = vec4(col, 1.0);
}
