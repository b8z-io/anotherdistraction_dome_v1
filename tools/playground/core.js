/* Another Distraction — browser port of lattice.py + timeline.py.
 *
 * Mirrors the Python exactly (same random numbers, same graph, same
 * timeline), so a params.json tuned in the playground renders identically
 * with render.py. Works in the browser (global `Core`) and in Node
 * (require) for the parity test in tools/test_parity.js.
 */
const Core = (() => {
  "use strict";

  // ------------------------------------------------------------------ numpy RNG
  // numpy.random.default_rng(seed) = Generator(PCG64(SeedSequence(seed)))
  const M32 = 0xffffffff;
  const INIT_A = 0x43b0d7e5, MULT_A = 0x931e8875, INIT_B = 0x8b51f9dd, MULT_B = 0x58f38ded;
  const MIX_MULT_L = 0xca01f9dd, MIX_MULT_R = 0x4973f715, XSHIFT = 16, POOL = 4;
  const mul32 = (a, b) => Math.imul(a, b) >>> 0;

  function coerceU32(entropy) {
    const vals = Array.isArray(entropy) ? entropy : [entropy];
    const out = [];
    for (let v of vals) {
      v = BigInt(v);
      if (v === 0n) { out.push(0); continue; }
      while (v > 0n) { out.push(Number(v & 0xffffffffn)); v >>= 32n; }
    }
    return out;
  }

  function seedSequenceState(entropy, nWords64) {
    const ent = coerceU32(entropy);
    const pool = new Array(POOL).fill(0);
    let hc = INIT_A;
    const hashmix = (value) => {
      value = (value ^ hc) >>> 0;
      hc = mul32(hc, MULT_A);
      value = mul32(value, hc);
      value = (value ^ (value >>> XSHIFT)) >>> 0;
      return value;
    };
    const mix = (x, y) => {
      let r = (mul32(MIX_MULT_L, x) - mul32(MIX_MULT_R, y)) >>> 0;
      return (r ^ (r >>> XSHIFT)) >>> 0;
    };
    for (let i = 0; i < POOL; i++) pool[i] = hashmix(i < ent.length ? ent[i] : 0);
    for (let s = 0; s < POOL; s++)
      for (let d = 0; d < POOL; d++)
        if (s !== d) pool[d] = mix(pool[d], hashmix(pool[s]));
    for (let s = POOL; s < ent.length; s++)
      for (let d = 0; d < POOL; d++) pool[d] = mix(pool[d], hashmix(ent[s]));
    // generate_state
    const n32 = nWords64 * 2, st = [];
    let h = INIT_B;
    for (let i = 0; i < n32; i++) {
      let v = pool[i % POOL];
      v = (v ^ h) >>> 0;
      h = mul32(h, MULT_B);
      v = mul32(v, h);
      v = (v ^ (v >>> XSHIFT)) >>> 0;
      st.push(v);
    }
    const out = [];
    for (let i = 0; i < nWords64; i++) out.push(BigInt(st[2 * i]) | (BigInt(st[2 * i + 1]) << 32n));
    return out;
  }

  const M128 = (1n << 128n) - 1n, M64 = (1n << 64n) - 1n;
  const PCG_MULT = (2549297995355413924n << 64n) + 4865540595714422341n;

  class Generator {
    constructor(seed) {
      const v = seedSequenceState(seed, 4);
      const initstate = (v[0] << 64n) | v[1];
      const initseq = (v[2] << 64n) | v[3];
      this.inc = ((initseq << 1n) | 1n) & M128;
      this.state = 0n;
      this._step();
      this.state = (this.state + initstate) & M128;
      this._step();
    }
    _step() { this.state = (this.state * PCG_MULT + this.inc) & M128; }
    next64() {
      this._step();
      const s = this.state;
      const x = ((s >> 64n) ^ s) & M64;
      const rot = s >> 122n;
      return ((x >> rot) | (x << ((64n - rot) & 63n))) & M64;
    }
    /** n doubles in [0, 1), like Generator.random(n) */
    random(n) {
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) out[i] = Number(this.next64() >> 11n) * (1.0 / 9007199254740992.0);
      return out;
    }
  }

  // ------------------------------------------------------------------ small maths
  const rad = (d) => d * Math.PI / 180;
  const matmul = (A, B) => A.map((r) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
  const mv = (A, v) => A.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
  const mtv = (A, v) => [0, 1, 2].map((j) => A[0][j] * v[0] + A[1][j] * v[1] + A[2][j] * v[2]); // A^T v
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const norm = (a) => Math.sqrt(dot(a, a));
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

  function eulerToMat(deg) {
    const [x, y, z] = deg.map(rad);
    const rx = [[1, 0, 0], [0, Math.cos(x), -Math.sin(x)], [0, Math.sin(x), Math.cos(x)]];
    const ry = [[Math.cos(y), 0, Math.sin(y)], [0, 1, 0], [-Math.sin(y), 0, Math.cos(y)]];
    const rz = [[Math.cos(z), -Math.sin(z), 0], [Math.sin(z), Math.cos(z), 0], [0, 0, 1]];
    return matmul(matmul(rz, ry), rx);
  }

  // ------------------------------------------------------------------ Dijkstra on the grid
  const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

  class Heap {   // min-heap of (key, id), ties broken by id like Python's tuples
    constructor() { this.k = []; this.v = []; }
    get size() { return this.k.length; }
    push(key, id) {
      const k = this.k, v = this.v;
      let i = k.length; k.push(key); v.push(id);
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (k[p] < key || (k[p] === key && v[p] <= id)) break;
        k[i] = k[p]; v[i] = v[p]; i = p;
      }
      k[i] = key; v[i] = id;
    }
    pop() {
      const k = this.k, v = this.v;
      const top = [k[0], v[0]];
      const lk = k.pop(), lv = v.pop();
      if (k.length) {
        let i = 0;
        const n = k.length;
        for (;;) {
          let c = 2 * i + 1;
          if (c >= n) break;
          if (c + 1 < n && (k[c + 1] < k[c] || (k[c + 1] === k[c] && v[c + 1] < v[c]))) c++;
          if (lk < k[c] || (lk === k[c] && lv <= v[c])) break;
          k[i] = k[c]; v[i] = v[c]; i = c;
        }
        k[i] = lk; v[i] = lv;
      }
      return top;
    }
  }

  // flat index = (i*N + j)*N + k  (numpy C order)
  function dijkstra(N, sources, stepOk, weight) {
    const n3 = N * N * N;
    const dist = new Float64Array(n3).fill(Infinity);
    const parent = new Int8Array(n3).fill(-1);
    const h = new Heap();
    for (const [s, v0] of sources) if (v0 < dist[s]) { dist[s] = v0; h.push(v0, s); }
    while (h.size) {
      const [d0, id] = h.pop();
      if (d0 > dist[id]) continue;
      const i = Math.floor(id / (N * N)), j = Math.floor(id / N) % N, k = id % N;
      for (let di = 0; di < 6; di++) {
        const u = i + DIRS[di][0], v = j + DIRS[di][1], w = k + DIRS[di][2];
        if (u < 0 || u >= N || v < 0 || v >= N || w < 0 || w >= N) continue;
        const nid = (u * N + v) * N + w;
        if (!stepOk(id, di, nid)) continue;
        const nd = d0 + weight(i, j, k, di);
        if (nd < dist[nid]) { dist[nid] = nd; parent[nid] = di ^ 1; h.push(nd, nid); }
      }
    }
    return { dist, parent };
  }

  // ------------------------------------------------------------------ lattice.build
  const rngCache = new Map();
  function latticeRandoms(seed, N) {
    const key = `${seed}:${N}`;
    if (!rngCache.has(key)) {
      const g = new Generator(seed), n3 = N * N * N;
      rngCache.clear();
      rngCache.set(key, { alive: g.random(n3), w: g.random(3 * n3), xl: g.random(3 * n3) });
    }
    return rngCache.get(key);
  }

  function buildLattice(P) {
    const L = P.lattice, S = P.seed_point;
    const c = L.cell;
    const H = Math.ceil(L.extent / c), N = 2 * H + 1, n3 = N * N * N;
    const R = latticeRandoms(P.seed, N);
    const rot = eulerToMat(L.rotation_deg);
    const seedL = mv(rot, S.position);
    const alive = new Uint8Array(n3);
    let best = Infinity, root = -1;
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) for (let k = 0; k < N; k++) {
      const id = (i * N + j) * N + k;
      const X = i - H, Y = j - H, Z = k - H;
      const r = Math.sqrt(X * X + Y * Y + Z * Z) * c;
      const a = R.alive[id] < L.site_density && r >= L.audience_void_radius && r <= L.extent;
      alive[id] = a ? 1 : 0;
      if (a) {
        const dx = X * c - seedL[0], dy = Y * c - seedL[1], dz = Z * c - seedL[2];
        const ds = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (ds < best) { best = ds; root = id; }
      }
    }
    const [lo, hi] = L.edge_weight_range;
    const wt = (i, j, k, d) => {
      const a = d >> 1;
      let id = (i * N + j) * N + k;
      if (d & 1) id = ((i + DIRS[d][0]) * N + (j + DIRS[d][1])) * N + (k + DIRS[d][2]);
      return c * (lo + (hi - lo) * R.w[a * n3 + id]);
    };
    const { dist, parent } = dijkstra(N, [[root, 0.0]], (id, d, nid) => alive[nid] === 1, wt);
    const reached = new Uint8Array(n3);
    for (let id = 0; id < n3; id++) reached[id] = isFinite(dist[id]) ? 1 : 0;
    const edge = new Int32Array(n3), cross = new Int32Array(n3);
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) for (let k = 0; k < N; k++) {
      const id = (i * N + j) * N + k;
      if (!reached[id]) continue;
      for (let d = 0; d < 6; d++) {
        const u = i + DIRS[d][0], v = j + DIRS[d][1], w = k + DIRS[d][2];
        if (parent[id] === d) edge[id] |= 1 << d;
        if (u < 0 || u >= N || v < 0 || v >= N || w < 0 || w >= N) continue;
        const nid = (u * N + v) * N + w;
        if (!reached[nid]) continue;
        if (parent[nid] === (d ^ 1)) edge[id] |= 1 << d;
        const xid = (d & 1) ? nid : id;                     // one draw per undirected edge
        if (R.xl[(d >> 1) * n3 + xid] < L.crosslink_density) cross[id] |= 1 << d;
      }
      edge[id] |= cross[id];
    }
    // texture: x fastest -> index (k*N + j)*N + i
    const tex = new Float32Array(n3 * 4);
    const nodeIdx = [], nodeDist = [], nodeWorld = [];
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) for (let k = 0; k < N; k++) {
      const id = (i * N + j) * N + k, t = ((k * N + j) * N + i) * 4;
      tex[t] = reached[id] ? dist[id] : -1;
      tex[t + 1] = edge[id];
      tex[t + 2] = cross[id];
      if (reached[id]) {
        nodeIdx.push(id);
        nodeDist.push(dist[id]);
        nodeWorld.push(mtv(rot, [(i - H) * c, (j - H) * c, (k - H) * c]));
      }
    }
    const ri = Math.floor(root / (N * N)), rj = Math.floor(root / N) % N, rk = root % N;
    return {
      N, H, cell: c, rot, root, dist, reached, wt, tex,
      nodeIdx, nodeDist: Float64Array.from(nodeDist), nodeWorld,
      rootWorld: mtv(rot, [(ri - H) * c, (rj - H) * c, (rk - H) * c]),
      stats: { grid: N, reached: nodeIdx.length },
    };
  }

  function paintField(G, landNode, landT, speed, limit, brushed, brushSpeed, brushReach) {
    const { N, reached, wt } = G, n3 = N * N * N;
    const ok = (id, d, nid) => reached[nid] === 1;
    const { dist: d } = dijkstra(N, [[landNode, 0.0]], ok, wt);
    const arr = new Float64Array(n3), cov = new Float64Array(n3);
    for (let id = 0; id < n3; id++) {
      const frac = d[id] / limit;
      arr[id] = frac < 0.98 ? landT - (limit / speed) * Math.log1p(-Math.min(frac, 0.98)) : Infinity;
      const x = Math.min(Math.max((frac - 0.55) / 0.43, 0), 1);
      cov[id] = 1 - x * x;
    }
    if (brushed.length) {
      const { dist: tb } = dijkstra(N, brushed.map(([n, tp]) => [n, tp * brushSpeed]), ok, wt);
      const { dist: db } = dijkstra(N, brushed.map(([n]) => [n, 0.0]), ok, wt);
      for (let id = 0; id < n3; id++) {
        const inR = db[id] < brushReach;
        const arrB = inR ? tb[id] / brushSpeed : Infinity;
        const x = Math.min(Math.max((db[id] / brushReach - 0.4) / 0.6, 0), 1);
        const covB = inR ? 1 - x * x : 0;
        if (arrB < arr[id]) cov[id] = Math.max(covB, isFinite(arr[id]) ? cov[id] : 0);
        arr[id] = Math.min(arr[id], arrB);
      }
    }
    for (let id = 0; id < n3; id++) {
      if (!(isFinite(arr[id]) && reached[id])) { arr[id] = -1; cov[id] = 0; }
    }
    return { arr, cov };
  }

  function packPaint(fields, N) {
    const n3 = N * N * N, texs = [];
    for (let t = 0; t < 8; t++) {
      const out = new Float32Array(n3 * 4);
      for (let q = 0; q < n3; q++) { out[q * 4] = -1; out[q * 4 + 2] = -1; }
      for (let j = 0; j < 2; j++) {
        const f = fields[2 * t + j];
        if (!f) continue;
        for (let i = 0; i < N; i++) for (let jj = 0; jj < N; jj++) for (let k = 0; k < N; k++) {
          const id = (i * N + jj) * N + k, o = ((k * N + jj) * N + i) * 4 + 2 * j;
          out[o] = f.arr[id]; out[o + 1] = f.cov[id];
        }
      }
      texs.push(out);
    }
    return texs;
  }

  // ------------------------------------------------------------------ timeline.py
  function pchip(keys, t) {
    const ks = keys.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const xs = ks.map((k) => k[0]), ys = ks.map((k) => k[1]);
    if (t <= xs[0]) return ys[0];
    if (t >= xs[xs.length - 1]) return ys[ys.length - 1];
    const n = xs.length;
    const h = [], dl = [];
    for (let i = 0; i < n - 1; i++) { h.push(xs[i + 1] - xs[i]); dl.push((ys[i + 1] - ys[i]) / h[i]); }
    const m = new Array(n).fill(0);
    m[0] = dl[0]; m[n - 1] = dl[n - 2];
    for (let i = 1; i < n - 1; i++) {
      if (dl[i - 1] * dl[i] <= 0) m[i] = 0;
      else {
        const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1];
        m[i] = (w1 + w2) / (w1 / dl[i - 1] + w2 / dl[i]);
      }
    }
    let i = 0;
    for (let j = 0; j < n - 1; j++) if (xs[j] <= t) i = j;
    const s = (t - xs[i]) / h[i];
    const h00 = 2 * s ** 3 - 3 * s ** 2 + 1, h10 = s ** 3 - 2 * s ** 2 + s;
    const h01 = -2 * s ** 3 + 3 * s ** 2, h11 = s ** 3 - s ** 2;
    return h00 * ys[i] + h10 * h[i] * m[i] + h01 * ys[i + 1] + h11 * h[i] * m[i + 1];
  }
  function lerpKeys(keys, t) {
    const ks = keys.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (t <= ks[0][0]) return ks[0][1];
    for (let i = 0; i < ks.length - 1; i++) {
      const [t0, v0] = ks[i], [t1, v1] = ks[i + 1];
      if (t <= t1) return t1 > t0 ? v0 + (v1 - v0) * (t - t0) / (t1 - t0) : v1;
    }
    return ks[ks.length - 1][1];
  }
  const smooth = (x) => { x = Math.min(Math.max(x, 0), 1); return x * x * (3 - 2 * x); };
  const easeIO = (x) => { x = Math.min(Math.max(x, 0), 1); return x * x * x * (x * (6 * x - 15) + 10); };
  const dirFrom = (az, el) => [Math.sin(rad(az)) * Math.cos(rad(el)), Math.sin(rad(el)), -Math.cos(rad(az)) * Math.cos(rad(el))];
  const yawMat = (deg) => { const a = rad(deg); return [[Math.cos(a), 0, Math.sin(a)], [0, 1, 0], [-Math.sin(a), 0, Math.cos(a)]]; };

  function linspace(a, b, n, endpoint = true) {
    const div = endpoint ? n - 1 : n, step = (b - a) / div, out = [];
    for (let i = 0; i < n; i++) out.push(a + i * step);
    if (endpoint && n > 1) out[n - 1] = b;
    return out;
  }

  function interp(x, xp, fp) {
    if (x <= xp[0]) return fp[0];
    if (x >= xp[xp.length - 1]) return fp[fp.length - 1];
    let lo = 0, hi = xp.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xp[mid] <= x) lo = mid; else hi = mid; }
    const s = (fp[hi] - fp[lo]) / (xp[hi] - xp[lo]);
    return s * (x - xp[lo]) + fp[lo];
  }

  function catmullRom(pts, samples = 600) {
    let p = pts.map((x) => x.slice());
    p = [sub(scl(p[0], 2), p[1]), ...p, sub(scl(p[p.length - 1], 2), p[p.length - 2])];
    const out = [];
    for (let i = 1; i < p.length - 2; i++) {
      const [p0, p1, p2, p3] = [p[i - 1], p[i], p[i + 1], p[i + 2]];
      const t0 = 0, t1 = t0 + norm(sub(p1, p0)) ** 0.5 + 1e-6;
      const t2 = t1 + norm(sub(p2, p1)) ** 0.5 + 1e-6, t3 = t2 + norm(sub(p3, p2)) ** 0.5 + 1e-6;
      for (const tt of linspace(t1, t2, 60, false)) {
        const a1 = add(scl(p0, (t1 - tt) / (t1 - t0)), scl(p1, (tt - t0) / (t1 - t0)));
        const a2 = add(scl(p1, (t2 - tt) / (t2 - t1)), scl(p2, (tt - t1) / (t2 - t1)));
        const a3 = add(scl(p2, (t3 - tt) / (t3 - t2)), scl(p3, (tt - t2) / (t3 - t2)));
        const b1 = add(scl(a1, (t2 - tt) / (t2 - t0)), scl(a2, (tt - t0) / (t2 - t0)));
        const b2 = add(scl(a2, (t3 - tt) / (t3 - t1)), scl(a3, (tt - t1) / (t3 - t1)));
        out.push(add(scl(b1, (t2 - tt) / (t2 - t1)), scl(b2, (tt - t1) / (t2 - t1))));
      }
    }
    out.push(p[p.length - 2]);
    const s = [0];
    for (let i = 1; i < out.length; i++) s.push(s[i - 1] + norm(sub(out[i], out[i - 1])));
    const total = s[s.length - 1];
    const us = linspace(0, total, samples);
    const xs0 = out.map((q) => q[0]), xs1 = out.map((q) => q[1]), xs2 = out.map((q) => q[2]);
    const res = us.map((u) => [interp(u, s, xs0), interp(u, s, xs1), interp(u, s, xs2)]);
    return { path: res, length: total };
  }

  class Timeline {
    constructor(P, onProgress) {
      this.P = P;
      this.G = buildLattice(P);
      this.tangents = (P.tangents || []).map((T, i) => this._resolve(i, T));
      if (this.tangents.length > 16) throw new Error("At most 16 tangents (shader limit).");
      const fields = this.tangents.map((T) => this._paint(T));
      this.paintTex = packPaint(fields, this.G.N);
    }
    front(t) { const k = this.P.growth.front_keys; return t < k[0][0] ? -1 : pchip(k, t); }
    star(t) {
      const s = this.P.seed_point, [a, b] = s.star_fade_in_s;
      const k = s.star_keys ? lerpKeys(s.star_keys, t) : 1;
      return s.star_intensity * smooth((t - a) / Math.max(b - a, 1e-6)) * k;
    }
    show() { return this.P.show || {}; }
    master(t) { const k = this.show().master_keys; return k ? lerpKeys(k, t) : 1; }
    latticeLevel(t) { const k = this.show().lattice_keys; return k ? lerpKeys(k, t) : 1; }
    focus(t) { const k = this.show().focus_keys; return k ? Math.min(Math.max(pchip(k, t), 0), 1) : 0; }
    shell(t) {
      const N = this.P.nova;
      if (!N || t < N.t) return [0, 1, 0];
      const dt = t - N.t;
      return [N.shell_speed * dt, N.shell_width, N.intensity * Math.exp(-dt / N.decay_s)];
    }
    quote(t) {
      const Q = this.P.quote;
      if (!Q) return [-1, 0, 0];
      const f = Q.fade_s;
      for (let i = 0; i < Q.cards.length; i++) {
        const c = Q.cards[i];
        if (c.in <= t && t <= c.out) {
          const a = Math.min(smooth((t - c.in) / f), 1 - smooth((t - c.out + f * 2.5) / (f * 2.5)));
          let cr = 0;
          if (i === Q.cards.length - 1) {
            const last = Q.cards[Q.cards.length - 1];
            cr = Math.min(smooth((t - Q.credit_in) / (f * 1.5)), 1 - smooth((t - last.out + f * 2.5) / (f * 2.5)));
          }
          return [i, a, cr];
        }
      }
      return [-1, 0, 0];
    }
    meteor(t, k = 24) {
      const M = this.P.meteor;
      if (!M || !(M.t <= t && t <= M.t + M.dur)) return null;
      const { pos: cam, R } = this.camera(M.t);
      const a = dirFrom(M.from_dir[0], M.from_dir[1]), b = dirFrom(M.to_dir[0], M.to_dir[1]);
      const om = Math.acos(Math.min(Math.max(dot(a, b), -1), 1));
      const slerp = (x) => scl(add(scl(a, Math.sin((1 - x) * om)), scl(b, Math.sin(x * om))), 1 / Math.sin(om));
      const u = (t - M.t) / M.dur * (1 + M.trail);
      const head = Math.min(u, 1), tail = Math.min(Math.max(u - M.trail, 0), 1);
      if (head - tail < 1e-4) return null;
      const env = smooth(u / 0.25) * (1 - smooth((u - 1) / M.trail));
      const ss = linspace(tail, head, k), al = linspace(0, 1, k);
      return { pts: ss.map((x) => add(cam, scl(mv(R, slerp(x)), M.dist))), inten: al.map((x) => x ** 1.6 * M.intensity * env) };
    }
    camera(t) {
      const C = this.P.camera;
      return { pos: [pchip(C.x_keys, t), pchip(C.y_keys, t), pchip(C.z_keys, t)], R: yawMat(pchip(C.yaw_keys, t)) };
    }
    _pick(t, cam, R, az, el, rmin, rmax, exclude) {
      const G = this.G, f = this.front(t) - 2 * G.cell;
      const target = mv(R, dirFrom(az, el));
      let best = -Infinity, bi = -1;
      for (let n = 0; n < G.nodeIdx.length; n++) {
        if (!(G.nodeDist[n] < f) || G.nodeIdx[n] === exclude) continue;
        const rel = sub(G.nodeWorld[n], cam), r = norm(rel);
        if (!(r > rmin && r < rmax)) continue;
        if (!(mtv(R, rel)[1] > 0.15 * r)) continue;
        const ca = dot(rel, target) / Math.max(r, 1e-6);
        if (ca > best) { best = ca; bi = n; }
      }
      if (bi < 0) throw new Error(`No grown lattice near the tangent at ${t.toFixed(1)}s. Grow the lattice further first, or move the tangent later.`);
      return bi;
    }
    _resolve(i, T) {
      const G = this.G, rng = new Generator([this.P.seed, 1000 + i]);
      const t0 = T.launch_s, { pos: cam, R } = this.camera(t0);
      const si = this._pick(t0, cam, R, T.from_dir[0], T.from_dir[1], 6, 18, -1);
      const tl = t0 + T.flight_s, cl = this.camera(tl);
      const li = this._pick(tl, cl.pos, cl.R, T.land_dir[0], T.land_dir[1], 6, 18, G.nodeIdx[si]);
      const src = G.nodeWorld[si], land = G.nodeWorld[li];
      const far = add(cam, scl(mv(R, dirFrom(T.out_dir[0], T.out_dir[1])), T.out_dist));
      const loopR = T.loop_radius ?? 4.0;
      let side = cross(sub(far, src), [0, 1, 0]); side = scl(side, 1 / (norm(side) + 1e-9));
      let up = cross(side, sub(far, src)); up = scl(up, 1 / (norm(up) + 1e-9));
      const jitter = (s) => Array.from(rng.random(3), (v) => (v * 2 - 1) * s * 1.7320508075688772);
      const pts = [
        src,
        add(add(add(add(src, scl(sub(far, src), 0.3)), scl(side, 2.5)), scl(up, 1.5)), jitter(0.8)),
        add(sub(far, scl(side, loopR)), jitter(0.6)),
        add(add(far, scl(scl(up, loopR), 0.8)), jitter(0.6)),
        add(add(far, scl(side, loopR)), jitter(0.6)),
        add(sub(add(far, scl(sub(land, far), 0.55)), scl(up, 1.5)), jitter(0.8)),
        land,
      ];
      const { path, length } = catmullRom(pts);
      return { ...T, index: i, srcNode: G.nodeIdx[si], landNode: G.nodeIdx[li], src, land, far, path, length, land_s: tl };
    }
    _paint(T) {
      const G = this.G, B = this.P.paint, brushed = new Map();
      const n = Math.ceil((T.land_s - T.launch_s) / 0.04);
      for (let q = 0; q < n; q++) {
        const t = T.launch_s + q * 0.04;
        const rb = this.ribbon(T, t);
        if (!rb) continue;
        const head = rb.pts[rb.pts.length - 1], f = this.front(t);
        for (let i = 0; i < G.nodeIdx.length; i++) {
          if (brushed.has(i) || !(G.nodeDist[i] < f)) continue;
          if (norm(sub(G.nodeWorld[i], head)) < B.brush_radius) brushed.set(i, t);
        }
      }
      const f = paintField(G, T.landNode, T.land_s, T.spread_speed, T.spread_limit,
        [...brushed.entries()].sort((a, b) => a[0] - b[0]).map(([i, tp]) => [G.nodeIdx[i], tp]),
        B.brush_speed, B.brush_reach);
      T.nBrushed = brushed.size;
      T.paintArr = f.arr;
      return f;
    }
    ribbon(T, t, k = 24) {
      const L = T.length, trail = T.trail;
      const u = (t - T.launch_s) / T.flight_s;
      if (u <= 0) return null;
      let head, tail;
      if (u <= 1) { head = L * easeIO(u); tail = Math.max(0, head - trail); }
      else {
        const a = (t - T.land_s) / T.absorb_s;
        if (a >= 1) return null;
        head = L;
        const tail0 = Math.max(0, L - trail);
        tail = tail0 + (L - tail0) * easeIO(a);
      }
      if (head - tail < 1e-3) return null;
      const ss = linspace(tail, head, k), along = linspace(0, 1, k), np = T.path.length;
      const pts = [], inten = [];
      for (let q = 0; q < k; q++) {
        const idx = ss[q] / L * (np - 1);
        const lo = Math.min(Math.max(Math.floor(idx), 0), np - 2), f = idx - lo;
        pts.push(add(scl(T.path[lo], 1 - f), scl(T.path[lo + 1], f)));
        inten.push(along[q] ** 1.6 * T.intensity);
      }
      return { pts, inten };
    }
    flash(T, t) { const dt = t - T.land_s; return dt < 0 ? 0 : T.intensity * 2 * Math.exp(-dt / 1.2); }
    pulse(T, t) { return t < T.launch_s ? 0 : T.pulse * (t < T.land_s ? 1 : Math.exp(-(t - T.land_s) / 7)); }
    end() {
      if (this.show().end_s) return this.show().end_s;
      const lastKey = (keys) => Math.max(...keys.map((k) => k[0]));
      const C = this.P.camera;
      return Math.max(lastKey(this.P.growth.front_keys), lastKey(C.y_keys), lastKey(C.yaw_keys),
        ...this.tangents.map((T) => T.land_s + T.absorb_s + 6));
    }
  }

  return { Generator, seedSequenceState, buildLattice, paintField, Timeline, pchip, lerpKeys, dirFrom, eulerToMat };
})();
if (typeof module !== "undefined") module.exports = Core;
