"""Dump reference values from the Python pipeline for tools/test_parity.js."""
import json, sys
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import timeline as tl

P = json.loads((Path(__file__).resolve().parents[1] / "params.json").read_text())
T = tl.Timeline(P)
G = T.G
N = G["N"]
flat = lambda ijk: int((ijk[0] * N + ijk[1]) * N + ijk[2])
rng = np.random.default_rng(np.random.SeedSequence(0))
pick = rng.integers(0, N ** 3 * 4, 4000)
texflat = G["tex"].reshape(-1)
out = {
    "params": P,
    "rng1": np.random.default_rng(1).random(4).tolist(),
    "rng2": np.random.default_rng([1, 1000]).random(3).tolist(),
    "root": flat(G["root"]),
    "node_idx": [flat(x) for x in G["node_idx"]],
    "node_dist": G["node_dist"].tolist(),
    "tex_sample_at": pick.tolist(), "tex_sample": texflat[pick].tolist(),
    "tangents": [],
    "camera": [[t, T.camera(t)[0].tolist(), T.front(t)] for t in (0, 30.5, 47.25, 66.6, 89.9)],
}
for X in T.tangents:
    rb = []
    for t in (X["launch_s"] + 0.7, X["launch_s"] + X["flight_s"] * 0.5, X["land_s"] + 0.4):
        r = T.ribbon(X, t)
        rb.append([t, r[0].tolist()])
    out["tangents"].append({
        "src_node": flat(X["src_node"]), "land_node": flat(X["land_node"]),
        "path": X["path"][::25].tolist(), "n_brushed": X["n_brushed"],
        "paint_arrival": X["paint_arrival"].tolist(), "ribbons": rb,
    })
json.dump(out, sys.stdout)
