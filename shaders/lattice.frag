#version 330
// Another Distraction
// Stateless: every pixel is a pure function of (uniforms for time t, params, seed).
// Renders straight into a 180° equidistant (azimuthal) fisheye domemaster,
// or an equirectangular frame for VR-headset preview.
//
// Spaces: world (audience at origin, +y zenith, -z front), lattice = uLatRot * world.

out vec4 fragColor;

// ---- output
uniform vec2  uRes;
uniform int   uProj;        // 0 = domemaster, 1 = equirectangular
uniform float uFov;         // fisheye field of view, degrees
uniform float uTilt;        // dome tilt, degrees (tips zenith toward front)
uniform int   uSS;          // supersampling per axis
uniform float uSeed;

// ---- camera
uniform vec3  uCamPos;      // world
uniform mat3  uCamRot;      // camera -> world
uniform float uVoidIn;      // nothing closer than this to the camera
uniform float uVoidOut;     // ...and struts fade in from uVoidIn to here

// ---- lattice
uniform mat3  uLatRot;      // world -> lattice
uniform float uCell;
uniform float uStrutR;
uniform float uNodeR;
uniform sampler3D uGraph;   // r = reveal path dist, g = edge bits, b = cross-link bits
uniform int   uGridH;
uniform float uExtent;
uniform float uFront;       // growth front (path units)
uniform float uXDelay;      // cross-links appear this far behind the front

// ---- seed star
uniform vec3  uSeedPos;     // world (= root node)
uniform float uStar;
uniform float uStarSize;

// ---- colour brought back by tangents (indexed by tangent, max 16)
uniform float uTime;
uniform sampler3D uPaint0;  // per node: (arrival s, coverage) for tangents 0,1
uniform sampler3D uPaint1;  // ...2,3
uniform sampler3D uPaint2;  // ...4,5
uniform sampler3D uPaint3;  // ...6,7
uniform sampler3D uPaint4;  // ...8,9
uniform sampler3D uPaint5;  // ...10,11
uniform sampler3D uPaint6;  // ...12,13
uniform sampler3D uPaint7;  // ...14,15
uniform int   uNumT;
uniform vec4  uSpCol[16];   // rgb = the tangent's own colour, a = launch time (nothing to paint before it)
uniform vec4  uSpA[16];     // landing time, hue drift (radians), hue drift time (s), wavefront brightness
uniform vec4  uSpB[16];     // colour recedes from fade start (s) over fade length (s); length 0 = it stays
uniform float uSoftT;       // fade-in time as colour arrives at a node (s)
uniform float uPulseT;      // duration of the wavefront flash at a node (s)
uniform float uTintAmt;     // how fully the colour replaces the cool base
uniform float uHueJitter;   // node-to-node hue variation (radians)
uniform float uVivid;       // brightness of painted struts relative to the base

// ---- the show
uniform float uMaster;      // overall picture level: 0 = black (the cut, the end)
uniform float uFocus;       // hyperfocus: 0..1 dims everything but one tangent's colour
uniform int   uFocusIdx;    // ...this one

// ---- ribbons in flight (per active slot, max 4; 24 points each, tail -> head)
uniform int   uNumRib;
uniform vec4  uRib[96];     // xyz world, w intensity
uniform vec4  uRibCol[4];   // rgb, w = width
uniform vec4  uFlash[8];    // xyz world, w amplitude (ribbon heads + landing flashes)
uniform vec4  uFlashCol[8]; // rgb, w = size

// ---- look
uniform vec3  uColDeep;
uniform vec3  uColStrut;
uniform vec3  uColTip;
uniform float uGlow;
uniform float uGlowW;
uniform float uTipGlow;
uniform float uFogDist;
uniform float uExposure;
uniform int   uSteps;
uniform float uFar;

const float PI = 3.14159265359;
const int K = 24;

float hash31(vec3 p) {
    p = fract(p * 0.1031 + uSeed * 0.0173);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
}

vec3 camL;  // camera in lattice space

ivec3 gridOf(vec3 id) { return ivec3(id) + uGridH; }
bool inGrid(ivec3 g) { return all(greaterThanEqual(g, ivec3(0))) && all(lessThanEqual(g, ivec3(2 * uGridH))); }

vec3 cellData(vec3 id) {
    ivec3 g = gridOf(id);
    if (!inGrid(g)) return vec3(-1.0, 0.0, 0.0);
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

vec3 hueRot(vec3 c, float a) {
    const vec3 k = vec3(0.57735027);
    float ca = cos(a);
    return max(c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca), 0.0);
}

vec4 paintTex(ivec3 g, int t) {
    return t == 0 ? texelFetch(uPaint0, g, 0) : t == 1 ? texelFetch(uPaint1, g, 0)
         : t == 2 ? texelFetch(uPaint2, g, 0) : t == 3 ? texelFetch(uPaint3, g, 0)
         : t == 4 ? texelFetch(uPaint4, g, 0) : t == 5 ? texelFetch(uPaint5, g, 0)
         : t == 6 ? texelFetch(uPaint6, g, 0) : texelFetch(uPaint7, g, 0);
}

// Colour carried back by tangents, at one lattice node.
// Returns premultiplied colour (rgb) + coverage (a); emis = wavefront glow.
vec4 spreadAt(vec3 id, out vec3 emis) {
    emis = vec3(0.0);
    vec4 acc = vec4(0.0);
    ivec3 g = gridOf(id);
    if (uNumT == 0 || !inGrid(g)) return acc;
    for (int t = 0; t < 8; t++) {
        if (2 * t >= uNumT) break;
        if (uTime < uSpCol[2 * t].a && (2 * t + 1 >= uNumT || uTime < uSpCol[2 * t + 1].a)) continue;  // nothing launched yet
        vec4 v = paintTex(g, t);
        for (int j = 0; j < 2; j++) {
            int i = 2 * t + j;
            if (i >= uNumT) break;
            float arr = j == 0 ? v.x : v.z, cov = j == 0 ? v.y : v.w;
            if (arr < 0.0 || uTime < arr - uPulseT * 2.0) continue;
            float dt = uTime - arr;
            vec4 A = uSpA[i];
            // hue drifts across the stain (early = the ribbon's own colour), plus a little per node
            float drift = A.y * clamp((arr - A.x) / A.z, -0.4, 1.0);
            float jit = (hash31(id * 1.37 + float(i) * 7.1) - 0.5) * uHueJitter;
            vec3 col = hueRot(uSpCol[i].rgb, drift + jit);
            float keep = i == uFocusIdx ? 1.0 : 1.0 - 0.7 * uFocus;
            vec4 B = uSpB[i];
            if (B.y > 0.0) {                     // a colour that recedes (e.g. hyperfocus washing out)
                cov *= 1.0 - smoothstep(B.x, B.x + B.y, uTime);
                if (cov <= 0.0) continue;
            }
            float w = clamp(dt / uSoftT + 0.5, 0.0, 1.0) * cov * uTintAmt;
            acc = acc * (1.0 - w) + vec4(col * keep, 1.0) * w;
            float x = dt / uPulseT;
            emis += col * exp(-x * x) * cov * A.w * keep;
        }
    }
    return acc;
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
    // keep a bubble of clear space around the audience
    d = max(d, uVoidIn - length(p - camL));
    return min(d, 0.5 * c);
}

// colour of the strut surface at p: cool base, blended along the strut
// between the two nodes' carried-back colours
vec3 strutColour(vec3 p, float tip, out vec3 emis, out float painted) {
    float c = uCell;
    vec3 id = floor(p / c + 0.5);
    vec3 q = p - id * c;
    vec3 aq = abs(q);
    vec3 dir = aq.x > aq.y && aq.x > aq.z ? vec3(sign(q.x), 0, 0)
             : aq.y > aq.z ? vec3(0, sign(q.y), 0) : vec3(0, 0, sign(q.z));
    float h = clamp(max(aq.x, max(aq.y, aq.z)) / c, 0.0, 0.5);
    vec3 e0, e1;
    vec4 s0 = spreadAt(id, e0);
    vec4 s1 = spreadAt(id + dir, e1);
    vec4 s = mix(s0, s1, h);
    emis = mix(e0, e1, h);
    vec3 base = mix(uColStrut, uColTip, clamp(tip * 1.5, 0.0, 1.0)) * (1.0 - 0.75 * uFocus);
    painted = s.a;
    return base * (1.0 - s.a) + s.rgb * uVivid;
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
    d = vec3(d.x, d.y * cos(tl) - d.z * sin(tl), d.y * sin(tl) + d.z * cos(tl));
    return normalize(d);
}

// closest approach between a ray and a segment: returns distance, tRay = depth along the ray, h = position on segment
float raySeg(vec3 ro, vec3 rd, vec3 a, vec3 b, out float tRay, out float h) {
    vec3 ba = b - a, w0 = ro - a;
    float bb = dot(rd, ba), cc = dot(ba, ba), dd = dot(rd, w0), ee = dot(ba, w0);
    float den = cc - bb * bb;
    h = den > 1e-8 ? clamp((ee - bb * dd) / den, 0.0, 1.0) : 0.0;
    vec3 pt = a + ba * h;
    tRay = max(dot(pt - ro, rd), 0.0);
    return length(ro + rd * tRay - pt);
}

vec3 ribbons(vec3 ro, vec3 rd, float tHit) {
    vec3 col = vec3(0.0);
    for (int r = 0; r < 4; r++) {
        if (r >= uNumRib) break;
        float w = uRibCol[r].w;
        float core = 0.0, halo = 0.0;
        for (int i = 0; i < K - 1; i++) {
            vec4 a = uRib[r * K + i], b = uRib[r * K + i + 1];
            float tr, h;
            float d = raySeg(ro, rd, a.xyz, b.xyz, tr, h);
            float inten = mix(a.w, b.w, h);
            float ww = w * (0.3 + 0.7 * mix(float(i), float(i + 1), h) / float(K - 1)); // tapers to the tail
            float occ = tr > tHit ? 0.15 : 1.0;           // behind a strut
            core = max(core, inten * occ * exp(-(d * d) / (ww * ww)));
            halo = max(halo, inten * occ * (0.45 * exp(-(d * d) / (16.0 * ww * ww)) + 0.08 * exp(-d / (ww * 14.0))));
        }
        col += mix(uRibCol[r].rgb, vec3(1.0), 0.55) * core + uRibCol[r].rgb * halo;
    }
    // glowing heads and landing flashes
    for (int f = 0; f < 8; f++) {
        if (uFlash[f].w <= 0.0) continue;
        vec3 to = uFlash[f].xyz - ro;
        float dist = length(to);
        float ang = acos(clamp(dot(rd, to / dist), -1.0, 1.0));
        float x = ang * dist / uFlashCol[f].w;          // in units of the flash's world-space size
        col += uFlash[f].w * (mix(uFlashCol[f].rgb, vec3(1.0), 0.5) * exp(-x * x)
                              + uFlashCol[f].rgb * (0.35 * exp(-x * x / 9.0) + 0.015 * exp(-x / 3.0)));
    }
    return col;
}

vec3 shade(vec3 rdCam) {
    vec3 rd = uCamRot * rdCam;            // world-space ray
    vec3 col = vec3(0.0);

    // seed star
    vec3 toSeed = normalize(uSeedPos - uCamPos);
    float ang = acos(clamp(dot(rd, toSeed), -1.0, 1.0));
    col += uColTip * uStar * (exp(-pow(ang / uStarSize, 2.0)) + 0.25 * exp(-ang / (uStarSize * 6.0)));

    float tHit = 1e9;
    if (uFront > 0.0) {
        vec3 ro = camL;
        vec3 rl = uLatRot * rd;
        float t = 0.05;
        vec3 glow = vec3(0.0);
        float tipg = 0.0;
        vec3 hitCol = vec3(0.0);
        for (int i = 0; i < uSteps; i++) {
            vec3 p = ro + rl * t;
            float tip;
            float d = sdLattice(p, tip);
            float fog = exp(-t / uFogDist);
            float near = smoothstep(uVoidIn, uVoidOut, t);
            if (d < 0.49 * uCell) {          // occupied cells only: keep the sky black
                float g = fog * near / (1.0 + pow(max(d, 0.0) / uGlowW, 2.0));
                vec3 e;
                vec4 s = spreadAt(floor(p / uCell + 0.5), e);
                glow += g * (uColDeep * (1.0 - s.a) * (1.0 - 0.75 * uFocus) + s.rgb * 0.9) + e * g * 0.6;
            }
            tipg += fog * near * tip;
            if (d < 0.0008 * t) {
                vec3 emis;
                float painted;
                vec3 sc = strutColour(p, tip, emis, painted);
                // distant struts sink into deep blue — or, if painted, a deep shade of their own colour
                vec3 far = mix(uColDeep * 2.5 * (1.0 - 0.75 * uFocus), sc * 0.3, painted);
                vec3 base = mix(far, sc, fog);
                hitCol = (base * mix(0.35, 1.0, fog) + emis * fog * 0.35) * near;
                tHit = t;
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
        col += glow * uGlow * 0.02;
        col += uColTip * tipg * uTipGlow * 0.02;
    }
    col += ribbons(uCamPos, rd, tHit);
    return col;
}

vec3 tonemap(vec3 x) {
    // ACES fitted (Narkowicz)
    x *= uExposure;
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
    camL = uLatRot * uCamPos;
    vec3 acc = vec3(0.0);
    for (int sy = 0; sy < uSS; sy++)
    for (int sx = 0; sx < uSS; sx++) {
        vec2 off = (vec2(sx, sy) + 0.5) / float(uSS);
        vec3 rd = viewDir(gl_FragCoord.xy - 0.5 + off);
        if (dot(rd, rd) < 0.5) continue;  // outside the dome circle
        acc += shade(rd);
    }
    vec3 col = acc / float(uSS * uSS) * uMaster;
    col = tonemap(col);
    col = pow(col, vec3(1.0 / 2.2));
    // deterministic dither against banding in dark gradients
    float dth = hash31(vec3(gl_FragCoord.xy, 7.0)) - 0.5;
    col += dth / 255.0 * min(uMaster * 4.0, 1.0);   // true black when the show is dark
    fragColor = vec4(col, 1.0);
}
