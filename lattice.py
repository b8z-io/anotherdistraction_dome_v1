"""Growth graph for the lattice — a pure function of params.json.

Builds a sparse cubic lattice around the audience, then grows a shortest-path
tree out from the seed (Dijkstra with seeded random edge weights). Every node
is connected back to the seed, and each node's reveal value is its path
distance, so growth travels along branches rather than as an expanding ball.

Packed into a 3D float texture the shader reads with texelFetch:
  r = reveal path distance (-1 = empty site)
  g = edge mask, 6 bits (+x -x +y -y +z -z), tree edges and cross-links
  b = cross-link mask, 6 bits (subset of g)
  a = edge weight to parent (unused by shader yet; handy later)
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

    # root = alive site nearest the seed point
    dseed = np.sqrt((X * c - seedL[0])**2 + (Y * c - seedL[1])**2 + (Z * c - seedL[2])**2)
    dseed[~alive] = np.inf
    root = np.unravel_index(np.argmin(dseed), dseed.shape)

    # one random weight per undirected edge (cell -> +axis neighbour)
    lo, hi = L["edge_weight_range"]
    w_axis = lo + (hi - lo) * rng.random((3, N, N, N))
    xl = rng.random((3, N, N, N)) < L["crosslink_density"]

    def wt(i, j, k, d):
        a = d // 2
        if d % 2 == 0:
            return w_axis[a, i, j, k]
        di, dj, dk = DIRS[d]
        return w_axis[a, i + di, j + dj, k + dk]

    dist = np.full((N, N, N), np.inf)
    parent = np.full((N, N, N), -1, np.int8)   # direction index toward parent
    dist[root] = 0.0
    pq = [(0.0, root)]
    while pq:
        d0, (i, j, k) = heapq.heappop(pq)
        if d0 > dist[i, j, k]:
            continue
        for di, (a, b, e) in enumerate(DIRS):
            u, v, w = i + a, j + b, k + e
            if not (0 <= u < N and 0 <= v < N and 0 <= w < N) or not alive[u, v, w]:
                continue
            nd = d0 + c * wt(i, j, k, di)
            if nd < dist[u, v, w]:
                dist[u, v, w] = nd
                parent[u, v, w] = di ^ 1
                heapq.heappush(pq, (nd, (u, v, w)))

    reached = np.isfinite(dist)
    edge = np.zeros((N, N, N), np.int32)
    cross = np.zeros((N, N, N), np.int32)
    for d, (a, b, e) in enumerate(DIRS):
        # tree edge: I point at my parent, or my neighbour points back at me
        edge |= ((parent == d) & reached).astype(np.int32) << d
        nb = np.roll(parent, shift=(-a, -b, -e), axis=(0, 1, 2))
        nb_ok = np.roll(reached, shift=(-a, -b, -e), axis=(0, 1, 2))
        valid = np.ones((N, N, N), bool)
        if a: valid[(N - 1) if a > 0 else 0, :, :] = False
        if b: valid[:, (N - 1) if b > 0 else 0, :] = False
        if e: valid[:, :, (N - 1) if e > 0 else 0] = False
        edge |= ((nb == (d ^ 1)) & nb_ok & reached & valid).astype(np.int32) << d
        # cross-links between two reached neighbours (decided once per undirected edge)
        if d % 2 == 0:
            xm = xl[d // 2]
        else:
            xm = np.roll(xl[d // 2], shift=(-a, -b, -e), axis=(0, 1, 2))
        xm = xm & reached & nb_ok & valid
        cross |= xm.astype(np.int32) << d
    edge |= cross

    tex = np.zeros((N, N, N, 4), np.float32)
    tex[..., 0] = np.where(reached, dist, -1.0)
    tex[..., 1] = edge
    tex[..., 2] = cross
    stats = {
        "grid": N, "sites": int(alive.sum()), "reached": int(reached.sum()),
        "root_world": (rot.T @ (np.array(root) - H) * c).tolist(),
        "path_p50": float(np.percentile(dist[reached], 50)),
        "path_p90": float(np.percentile(dist[reached], 90)),
        "path_max": float(dist[reached].max()),
    }
    # texture3d wants x fastest: (z, y, x, 4)
    return np.ascontiguousarray(tex.transpose(2, 1, 0, 3)), H, rot, stats


if __name__ == "__main__":
    import json, sys
    P = json.load(open(sys.argv[1] if len(sys.argv) > 1 else "params.json"))
    _, _, _, s = build(P)
    print(json.dumps(s, indent=2))
