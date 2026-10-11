"""The single timeline both picture and sound read from.

Everything here is a pure function of (params.json, growth graph, t):
growth front, camera pose, each tangent's ribbon, landing flashes and how far
its colour has spread. render.py turns it into pixels, score.py into sound,
so the two can't drift apart.

Conventions (world space): audience at the origin, +y up (zenith), -z front,
+x right. Directions on the dome are (azimuth, elevation) in degrees relative
to the audience's front: az 0 = front, 90 = right, 180 = behind; el 0 =
horizon, 90 = zenith. Directions are in the *camera* frame, so "behind" stays
behind the audience while the camera turns.
"""
import math
from functools import lru_cache

import numpy as np

import lattice


# ---------------------------------------------------------------- curves

def pchip(keys, t):
    """Monotone cubic through [[t, v], ...] — smooth, no overshoot, holds at the ends."""
    ks = sorted(keys)
    xs = [k[0] for k in ks]
    ys = [k[1] for k in ks]
    if t <= xs[0]:
        return ys[0]
    if t >= xs[-1]:
        return ys[-1]
    n = len(xs)
    h = [xs[i + 1] - xs[i] for i in range(n - 1)]
    dl = [(ys[i + 1] - ys[i]) / h[i] for i in range(n - 1)]
    m = [0.0] * n
    m[0], m[-1] = dl[0], dl[-1]
    for i in range(1, n - 1):
        if dl[i - 1] * dl[i] <= 0:
            m[i] = 0.0
        else:
            w1, w2 = 2 * h[i] + h[i - 1], h[i] + 2 * h[i - 1]
            m[i] = (w1 + w2) / (w1 / dl[i - 1] + w2 / dl[i])
    i = max(j for j in range(n - 1) if xs[j] <= t)
    s = (t - xs[i]) / h[i]
    h00, h10 = 2 * s**3 - 3 * s**2 + 1, s**3 - 2 * s**2 + s
    h01, h11 = -2 * s**3 + 3 * s**2, s**3 - s**2
    return h00 * ys[i] + h10 * h[i] * m[i] + h01 * ys[i + 1] + h11 * h[i] * m[i + 1]


def lerp_keys(keys, t):
    """Straight lines between [[t, v], ...] — for cuts: two keys close together make a hard edge."""
    ks = sorted(keys)
    if t <= ks[0][0]:
        return ks[0][1]
    for (t0, v0), (t1, v1) in zip(ks, ks[1:]):
        if t <= t1:
            return v0 + (v1 - v0) * (t - t0) / (t1 - t0) if t1 > t0 else v1
    return ks[-1][1]


def smooth(x):
    x = min(max(x, 0.0), 1.0)
    return x * x * (3 - 2 * x)


def ease_io(x):
    """Smootherstep: gentle launch and landing."""
    x = min(max(x, 0.0), 1.0)
    return x * x * x * (x * (6 * x - 15) + 10)


def dir_from(az_deg, el_deg):
    az, el = math.radians(az_deg), math.radians(el_deg)
    return np.array([math.sin(az) * math.cos(el), math.sin(el), -math.cos(az) * math.cos(el)])


def yaw_mat(deg):
    a = math.radians(deg)
    # positive yaw turns the audience's front toward their right
    return np.array([[math.cos(a), 0, math.sin(a)], [0, 1, 0], [-math.sin(a), 0, math.cos(a)]])


def catmull_rom(pts, samples=600):
    """Centripetal Catmull-Rom through pts, resampled to constant arc length."""
    p = [np.asarray(x, float) for x in pts]
    p = [2 * p[0] - p[1]] + p + [2 * p[-1] - p[-2]]
    out = []
    for i in range(1, len(p) - 2):
        p0, p1, p2, p3 = p[i - 1], p[i], p[i + 1], p[i + 2]
        t0 = 0.0
        t1 = t0 + np.linalg.norm(p1 - p0) ** 0.5 + 1e-6
        t2 = t1 + np.linalg.norm(p2 - p1) ** 0.5 + 1e-6
        t3 = t2 + np.linalg.norm(p3 - p2) ** 0.5 + 1e-6
        for tt in np.linspace(t1, t2, 60, endpoint=False):
            a1 = (t1 - tt) / (t1 - t0) * p0 + (tt - t0) / (t1 - t0) * p1
            a2 = (t2 - tt) / (t2 - t1) * p1 + (tt - t1) / (t2 - t1) * p2
            a3 = (t3 - tt) / (t3 - t2) * p2 + (tt - t2) / (t3 - t2) * p3
            b1 = (t2 - tt) / (t2 - t0) * a1 + (tt - t0) / (t2 - t0) * a2
            b2 = (t3 - tt) / (t3 - t1) * a2 + (tt - t1) / (t3 - t1) * a3
            out.append((t2 - tt) / (t2 - t1) * b1 + (tt - t1) / (t2 - t1) * b2)
    out.append(p[-2])
    out = np.array(out)
    seg = np.linalg.norm(np.diff(out, axis=0), axis=1)
    s = np.concatenate([[0], np.cumsum(seg)])
    u = np.linspace(0, s[-1], samples)
    res = np.stack([np.interp(u, s, out[:, k]) for k in range(3)], axis=1)
    return res, float(s[-1])


# ---------------------------------------------------------------- the timeline

class Timeline:
    def __init__(self, P):
        self.P = P
        self.G = lattice.build(P)
        self.tangents = [self._resolve_tangent(i, T) for i, T in enumerate(P.get("tangents", []))]
        if len(self.tangents) > 16:
            raise ValueError("at most 16 tangents (shader limit)")
        fields = [self._paint(T) for T in self.tangents]
        self.paint_tex = lattice.pack_paint(fields, self.G["N"])

    # growth front, in path-distance units
    def front(self, t):
        keys = self.P["growth"]["front_keys"]
        return -1.0 if t < keys[0][0] else pchip(keys, t)

    def star(self, t):
        s = self.P["seed_point"]
        a, b = s["star_fade_in_s"]
        k = lerp_keys(s["star_keys"], t) if s.get("star_keys") else 1.0
        return s["star_intensity"] * smooth((t - a) / max(b - a, 1e-6)) * k

    def master(self, t):
        """Overall level of picture and sound: 0 = black and silent."""
        k = self.P.get("show", {}).get("master_keys")
        return lerp_keys(k, t) if k else 1.0

    def audio(self, t):
        """Overall level of the sound alone (the held breath before the supernova)."""
        k = self.P.get("show", {}).get("audio_keys")
        return lerp_keys(k, t) if k else 1.0

    def lattice_level(self, t):
        """Brightness of the lattice alone — the afterglow cooling and going out."""
        k = self.P.get("show", {}).get("lattice_keys")
        return lerp_keys(k, t) if k else 1.0

    def shell(self, t):
        """The supernova's shock shell: (radius, width, brightness)."""
        N = self.P.get("nova")
        if not N or t < N["t"]:
            return 0.0, 1.0, 0.0
        dt = t - N["t"]
        return N["shell_speed"] * dt, N["shell_width"], N["intensity"] * math.exp(-dt / N["decay_s"])

    # ---- the credo
    def quote(self, t):
        """(card index or -1, card opacity, credit opacity) at time t."""
        Q = self.P.get("quote")
        if not Q:
            return -1, 0.0, 0.0
        f = Q["fade_s"]
        for i, c in enumerate(Q["cards"]):
            if c["in"] <= t <= c["out"]:
                a = min(smooth((t - c["in"]) / f), 1 - smooth((t - c["out"] + f * 2.5) / (f * 2.5)))
                last = Q["cards"][-1]
                cr = 0.0
                if i == len(Q["cards"]) - 1:
                    cr = min(smooth((t - Q["credit_in"]) / (f * 1.5)), 1 - smooth((t - last["out"] + f * 2.5) / (f * 2.5)))
                return i, a, cr
        return -1, 0.0, 0.0

    # ---- the closing meteor
    def meteor(self, t, k=24):
        M = self.P.get("meteor")
        if not M or not (M["t"] <= t <= M["t"] + M["dur"]):
            return None
        cam, R = self.camera(M["t"])
        a, b = dir_from(*M["from_dir"]), dir_from(*M["to_dir"])
        om = math.acos(min(max(float(a @ b), -1.0), 1.0))
        def slerp(s):
            return (math.sin((1 - s) * om) * a + math.sin(s * om) * b) / math.sin(om)
        u = (t - M["t"]) / M["dur"] * (1 + M["trail"])
        head, tail = min(u, 1.0), min(max(u - M["trail"], 0.0), 1.0)
        if head - tail < 1e-4:
            return None
        env = smooth(u / 0.25) * (1 - smooth((u - 1.0) / M["trail"]))
        s = np.linspace(tail, head, k)
        pts = np.array([cam + R @ slerp(x) * M["dist"] for x in s])
        inten = np.linspace(0, 1, k) ** 1.6 * M["intensity"] * env
        return pts, inten

    def focus(self, t):
        """Hyperfocus: 0..1, dims everything except one tangent's colour."""
        k = self.P.get("show", {}).get("focus_keys")
        return min(max(pchip(k, t), 0.0), 1.0) if k else 0.0

    def dof(self, t):
        """Depth of field: (focus point in world space, strength 0..1).

        A bubble of sharpness follows the newest coloured blob: its head while it
        flies, then its landing node while the colour spreads. Blur grows with
        distance from that point (dof.sharp_radius -> dof.soft_radius). When the
        next blob launches, the focus glides to it over rack_s.
        """
        D = self.P.get("dof")
        live = sorted((T for T in self.tangents if T["launch_s"] <= t), key=lambda T: T["launch_s"])
        if not D or not live:
            return np.array([0.0, 0.0, -10.0]), 0.0
        s = min(max(lerp_keys(D["strength_keys"], t), 0.0), 1.0)

        def target(T):
            if t < T["land_s"]:
                h = self.head(T, t)
                return np.array(T["path"][0] if h is None else h, dtype=float)
            return np.array(T["land"], dtype=float)

        p = target(live[-1])
        if len(live) > 1:
            u = ease_io(min(max((t - live[-1]["launch_s"]) / max(D.get("rack_s", 0.7), 1e-3), 0.0), 1.0))
            p = target(live[-2]) * (1 - u) + p * u
        return p, s

    def end(self):
        """Length of the piece."""
        sh = self.P.get("show", {})
        if "end_s" in sh:
            return sh["end_s"]
        last = lambda keys: max(k[0] for k in keys)
        C = self.P["camera"]
        return max([last(self.P["growth"]["front_keys"]), last(C["y_keys"]), last(C["yaw_keys"])]
                   + [T["land_s"] + T["absorb_s"] + 6 for T in self.tangents])

    def camera(self, t):
        C = self.P["camera"]
        pos = np.array([pchip(C["x_keys"], t), pchip(C["y_keys"], t), pchip(C["z_keys"], t)])
        return pos, yaw_mat(pchip(C["yaw_keys"], t))

    # ---- tangents
    def _pick_node(self, t, cam_pos, cam_rot, az, el, rmin, rmax, exclude=()):
        G = self.G
        ok = G["node_dist"] < self.front(t) - 2 * G["cell"]
        rel = G["node_world"] - cam_pos
        r = np.linalg.norm(rel, axis=1)
        ok &= (r > rmin) & (r < rmax) & ((rel @ cam_rot)[:, 1] > 0.15 * r)   # above the horizon
        for e in exclude:
            ok &= ~np.all(G["node_idx"] == e, axis=1)
        if not ok.any():
            raise ValueError(f"no grown node for a tangent at t={t:.1f}s — grow the lattice further first")
        target = cam_rot @ dir_from(az, el)
        cosang = (rel @ target) / np.maximum(r, 1e-6)
        i = int(np.argmax(np.where(ok, cosang, -2)))
        return tuple(int(v) for v in G["node_idx"][i]), G["node_world"][i]

    def _resolve_tangent(self, i, T):
        rng = np.random.default_rng([self.P["seed"], 1000 + i])
        t0 = T["launch_s"]
        cam, R = self.camera(t0)
        src_idx, src = self._pick_node(t0, cam, R, *T["from_dir"], 6.0, 18.0)
        tl = t0 + T["flight_s"]
        cam_l, R_l = self.camera(tl)
        land_idx, land = self._pick_node(tl, cam_l, R_l, *T["land_dir"], 6.0, 18.0, exclude=[src_idx])

        far = cam + R @ dir_from(*T["out_dir"]) * T["out_dist"]
        loop_r = T.get("loop_radius", 4.0)
        # a lateral swing out, a loop around the far point, and a curve back in
        side = np.cross(far - src, [0, 1, 0]); side /= np.linalg.norm(side) + 1e-9
        up = np.cross(side, far - src); up /= np.linalg.norm(up) + 1e-9
        # uniform (same spread as a normal of std s): simple to reproduce exactly in the browser playground
        jitter = lambda s: (rng.random(3) * 2 - 1) * s * 1.7320508075688772
        pts = [
            src,
            src + (far - src) * 0.3 + side * 2.5 + up * 1.5 + jitter(0.8),
            far - side * loop_r + jitter(0.6),
            far + up * loop_r * 0.8 + jitter(0.6),
            far + side * loop_r + jitter(0.6),
            far + (land - far) * 0.55 - up * 1.5 + jitter(0.8),
            land,
        ]
        path, length = catmull_rom(pts)
        return {
            **T, "index": i, "src_node": src_idx, "land_node": land_idx,
            "src": src, "land": land, "path": path, "length": length,
            "land_s": tl,
        }

    def _paint(self, T):
        """Arrival time + coverage of T's colour at every lattice node (see lattice.paint_field)."""
        G, B = self.G, self.P["paint"]
        brushed = {}
        for t in np.arange(T["launch_s"], T["land_s"], 0.04):
            rb = self.ribbon(T, t)
            if rb is None:
                continue
            head = rb[0][-1]
            near = np.linalg.norm(G["node_world"] - head, axis=1) < B["brush_radius"]
            near &= G["node_dist"] < self.front(t)            # only struts that exist by then
            for i in np.flatnonzero(near):
                brushed.setdefault(i, t)
        arr, cov = lattice.paint_field(
            G, T["land_node"], T["land_s"], T["spread_speed"], T["spread_limit"],
            [(tuple(G["node_idx"][i]), tp) for i, tp in brushed.items()],
            B["brush_speed"], B["brush_reach"])
        ix = tuple(G["node_idx"].T)
        T["paint_arrival"], T["paint_cover"] = arr[ix], cov[ix]     # per node, for the score
        T["n_brushed"] = len(brushed)
        return arr, cov

    def head(self, T, t):
        rb = self.ribbon(T, t)
        return None if rb is None else rb[0][-1]

    def ribbon(self, T, t, k=24):
        """Ribbon polyline (k points, tail -> head) and per-point intensity, or None."""
        trail = T["trail"]
        L = T["length"]
        # head eases to the landing node by land_s; then the tail is absorbed over absorb_s
        u = (t - T["launch_s"]) / T["flight_s"]
        if u <= 0:
            return None
        if u <= 1:
            head = L * ease_io(u)
            tail = max(0.0, head - trail)
        else:
            a = (t - T["land_s"]) / T["absorb_s"]
            if a >= 1:
                return None
            head = L
            tail0 = max(0.0, L - trail)
            tail = tail0 + (L - tail0) * ease_io(a)
        if head - tail < 1e-3:
            return None
        s = np.linspace(tail, head, k)
        idx = s / T["length"] * (len(T["path"]) - 1)
        lo = np.floor(idx).astype(int).clip(0, len(T["path"]) - 2)
        f = (idx - lo)[:, None]
        pts = T["path"][lo] * (1 - f) + T["path"][lo + 1] * f
        along = np.linspace(0, 1, k)              # 0 tail .. 1 head
        inten = along ** 1.6 * T["intensity"]
        return pts, inten

    def flash(self, T, t):
        dt = t - T["land_s"]
        return 0.0 if dt < 0 else T["intensity"] * 2.0 * math.exp(-dt / 1.2)

    def pulse(self, T, t):
        """Brightness of the colour wavefront: steady while painting in flight, fading after landing."""
        if t < T["launch_s"]:
            return 0.0
        return T["pulse"] * (1.0 if t < T["land_s"] else math.exp(-(t - T["land_s"]) / 7.0))

    def spread_front(self, T, t):
        """Path distance the colour has travelled from the landing node."""
        dt = t - T["land_s"]
        if dt <= 0:
            return -1.0
        # starts at spread_speed (path units/s), eases to a stop at spread_limit
        return T["spread_limit"] * (1 - math.exp(-dt * T["spread_speed"] / T["spread_limit"]))


@lru_cache(maxsize=4)
def load(params_path):
    import json
    from pathlib import Path
    return Timeline(json.loads(Path(params_path).read_text()))
