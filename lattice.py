"""Growth graph for the lattice — a pure function of params.json.

Builds a sparse cubic lattice around the audience, then grows a shortest-path
tree out from the seed (Dijkstra with seeded random edge weights). Every node
is connected back to the seed, and each node's reveal value is its path
distance, so growth travels along branches rather than as an expanding ball.

Packed into a 3D float texture the shader reads with texelFetch:
  r = reveal path distance (-1 = empty site)
  g = edge mask, 6 bits (+x -x +y -y +z -z), tree edges and cross-links
  b = cross-link mask, 6 bits (subset of g)

`paint_field` adds, per tangent, when its colour reaches each node — brushed
by the ribbon in flight, or spreading out from where it lands like dye
through veins.
"""
import heapq
import math

import numpy as np

DIRS = [(1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)]


def euler_to_mat(deg):
    x, y, z = (math.radians(v) for v in deg)
    rx = np.array([[1, 0, 0], [0, math.cos(x), -math.sin(x)], [0, math.sin(x), math.cos(x)]])
    ry = np.array([[math.cos(y), 0, math.sin(y)], [0, 1, 0], [-math.sin(y), 0, math.cos(y)]])
    rz = np.array([[math.cos(z), -math.sin(z), 0], [math.sin(z), math.cos(z), 0], [0, 0, 1]])
    return rz @ ry @ rx


def _dijkstra(N, sources, step_ok, weight):
    """sources: [(node, starting value), ...]"""
    dist = np.full((N, N, N), np.inf)
    parent = np.full((N, N, N), -1, np.int8)
    pq = []
    for s, v0 in sources:
        s = tuple(int(x) for x in s)
        if v0 < dist[s]:
            dist[s] = v0
            pq.append((v0, s))
    heapq.heapify(pq)
    while pq:
        d0, (i, j, k) = heapq.heappop(pq)
        if d0 > dist[i, j, k]:
            continue
        for di, (a, b, e) in enumerate(DIRS):
            u, v, w = i + a, j + b, k + e
            if not (0 <= u < N and 0 <= v < N and 0 <= w < N) or not step_ok(i, j, k, di, u, v, w):
                continue
            nd = d0 + weight(i, j, k, di)
            if nd < dist[u, v, w]:
                dist[u, v, w] = nd
                parent[u, v, w] = di ^ 1
                heapq.heappush(pq, (nd, (u, v, w)))
    return dist, parent


def build(P):
    L, S = P["lattice"], P["seed_point"]
    c = L["cell"]
    H = int(math.ceil(L["extent"] / c))
    N = 2 * H + 1
    rng = np.random.default_rng(P["seed"])  # PCG64: stable across machines

    rot = euler_to_mat(L["rotation_deg"])          # world -> lattice
    seedL = rot @ np.array(S["position"], float)

    ax = np.arange(-H, H + 1)
    X, Y, Z = np.meshgrid(ax, ax, ax, indexing="ij")
    r = np.sqrt(X**2 + Y**2 + Z**2) * c
    alive = (rng.random((N, N, N)) < L["site_density"]) & (r >= L["audience_void_radius"]) & (r <= L["extent"])

    dseed = np.sqrt((X * c - seedL[0])**2 + (Y * c - seedL[1])**2 + (Z * c - seedL[2])**2)
    dseed[~alive] = np.inf
    root = tuple(int(v) for v in np.unravel_index(np.argmin(dseed), dseed.shape))

    lo, hi = L["edge_weight_range"]
    w_axis = lo + (hi - lo) * rng.random((3, N, N, N))
    xl = rng.random((3, N, N, N)) < L["crosslink_density"]

    def wt(i, j, k, d):
        a = d // 2
        if d % 2 == 0:
            return c * w_axis[a, i, j, k]
        di, dj, dk = DIRS[d]
        return c * w_axis[a, i + di, j + dj, k + dk]

    dist, parent = _dijkstra(N, [(root, 0.0)], lambda i, j, k, d, u, v, w: alive[u, v, w], wt)

    reached = np.isfinite(dist)
    edge = np.zeros((N, N, N), np.int32)
    cross = np.zeros((N, N, N), np.int32)
    for d, (a, b, e) in enumerate(DIRS):
        edge |= ((parent == d) & reached).astype(np.int32) << d
        nb = np.roll(parent, shift=(-a, -b, -e), axis=(0, 1, 2))
        nb_ok = np.roll(reached, shift=(-a, -b, -e), axis=(0, 1, 2))
        valid = np.ones((N, N, N), bool)
        if a: valid[(N - 1) if a > 0 else 0, :, :] = False
        if b: valid[:, (N - 1) if b > 0 else 0, :] = False
        if e: valid[:, :, (N - 1) if e > 0 else 0] = False
        edge |= ((nb == (d ^ 1)) & nb_ok & reached & valid).astype(np.int32) << d
        xm = xl[d // 2] if d % 2 == 0 else np.roll(xl[d // 2], shift=(-a, -b, -e), axis=(0, 1, 2))
        cross |= (xm & reached & nb_ok & valid).astype(np.int32) << d
    edge |= cross

    tex = np.zeros((N, N, N, 4), np.float32)
    tex[..., 0] = np.where(reached, dist, -1.0)
    tex[..., 1] = edge
    tex[..., 2] = cross

    idx = np.argwhere(reached)
    G = {
        "N": N, "H": H, "cell": c, "rot": rot, "root": root,
        "dist": dist, "edge": edge, "cross": cross, "wt": wt, "reached": reached,
        "node_idx": idx,
        "node_dist": dist[reached],
        "node_world": ((idx - H) * c) @ rot,       # lattice -> world (rot is orthonormal)
        "tex": np.ascontiguousarray(tex.transpose(2, 1, 0, 3)),   # texture3d wants x fastest
    }
    G["stats"] = {
        "grid": N, "sites": int(alive.sum()), "reached": int(reached.sum()),
        "root_world": (rot.T @ ((np.array(root) - H) * c)).tolist(),
        "path_p50": float(np.percentile(dist[reached], 50)),
        "path_max": float(dist[reached].max()),
    }
    return G


def paint_field(G, land_node, land_t, speed, limit, brushed, brush_speed, brush_reach):
    """When a tangent's colour reaches each lattice node, and how fully it covers it.

    Two ways a node gets painted:
      * brushed — the ribbon passed close by in flight (`brushed` = [(node, time), ...]);
        colour bleeds a little way (`brush_reach` path units) from there
      * stained — spreading out from the landing node at `land_t`, starting at
        `speed` path units/s and easing to a stop at `limit` path units
    Colour travels between any two neighbouring grown nodes, so it stains a region.
    Returns (arrival seconds, -1 = never; coverage 0..1), each (N, N, N).
    """
    N, reached, wt = G["N"], G["reached"], G["wt"]
    step_ok = lambda i, j, k, d, u, v, w: reached[u, v, w]
    d, _ = _dijkstra(N, [(land_node, 0.0)], step_ok, wt)
    frac = d / limit
    with np.errstate(divide="ignore", invalid="ignore"):
        arr = np.where(frac < 0.98, land_t - (limit / speed) * np.log1p(-np.minimum(frac, 0.98)), np.inf)
    cover = 1 - np.clip((frac - 0.55) / 0.43, 0, 1) ** 2
    if brushed:
        tb, _ = _dijkstra(N, [(n, tp * brush_speed) for n, tp in brushed], step_ok, wt)
        db, _ = _dijkstra(N, [(n, 0.0) for n, _ in brushed], step_ok, wt)
        ok = db < brush_reach
        arr_b = np.where(ok, tb / brush_speed, np.inf)
        cov_b = np.where(ok, 1 - np.clip((db / brush_reach - 0.4) / 0.6, 0, 1) ** 2, 0)
        cover = np.where(arr_b < arr, np.maximum(cov_b, np.where(np.isfinite(arr), cover, 0)), cover)
        arr = np.minimum(arr, arr_b)
    reach = np.isfinite(arr) & reached
    return np.where(reach, arr, -1.0), np.where(reach, cover, 0.0)


def pack_paint(fields, N):
    """[(arrival, cover), ...] for up to 8 tangents -> 4 RGBA textures (2 tangents each)."""
    texs = []
    for k in range(4):
        t = np.zeros((N, N, N, 4), np.float32)
        t[..., 0] = t[..., 2] = -1.0
        for j in range(2):
            i = 2 * k + j
            if i < len(fields):
                t[..., 2 * j], t[..., 2 * j + 1] = fields[i]
        texs.append(np.ascontiguousarray(t.transpose(2, 1, 0, 3)))
    return texs


if __name__ == "__main__":
    import json, sys
    P = json.load(open(sys.argv[1] if len(sys.argv) > 1 else "params.json"))
    print(json.dumps(build(P)["stats"], indent=2))
