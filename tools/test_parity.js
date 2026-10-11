// Parity check: the playground's JS port vs the Python pipeline.
// usage: python3 tools/dump_reference.py > /tmp/ref.json && node tools/test_parity.js /tmp/ref.json
const fs = require("fs");
const Core = require("./playground/core.js");
const ref = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
let fails = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name} ${detail}`); if (!ok) fails++; };

const g = new Core.Generator(1); const r = Array.from(g.random(4));
check("rng default_rng(1)", r.every((v, i) => v === ref.rng1[i]), JSON.stringify(r.slice(0, 2)));
const g2 = new Core.Generator([1, 1000]); const r2 = Array.from(g2.random(3));
check("rng default_rng([1,1000])", r2.every((v, i) => v === ref.rng2[i]));

const t0 = Date.now();
const TL = new Core.Timeline(ref.params);
console.log(`timeline built in ${Date.now() - t0} ms`);
const G = TL.G;
check("root", G.root === ref.root, `${G.root} vs ${ref.root}`);
check("reached count", G.nodeIdx.length === ref.node_idx.length, `${G.nodeIdx.length} vs ${ref.node_idx.length}`);
let maxd = 0, idxSame = true;
for (let i = 0; i < Math.min(G.nodeIdx.length, ref.node_idx.length); i++) {
  if (G.nodeIdx[i] !== ref.node_idx[i]) idxSame = false;
  maxd = Math.max(maxd, Math.abs(G.nodeDist[i] - ref.node_dist[i]));
}
check("node set", idxSame);
check("path distances", maxd < 1e-9, `max diff ${maxd}`);
let texd = 0;
for (let i = 0; i < ref.tex_sample.length; i++) texd = Math.max(texd, Math.abs(G.tex[ref.tex_sample_at[i]] - ref.tex_sample[i]));
check("graph texture sample", texd < 1e-4, `max diff ${texd}`);
TL.tangents.forEach((T, i) => {
  const R = ref.tangents[i];
  check(`tangent ${i} source/landing nodes`, T.srcNode === R.src_node && T.landNode === R.land_node);
  let pd = 0; for (let q = 0; q < R.path.length; q++) for (let c = 0; c < 3; c++) pd = Math.max(pd, Math.abs(T.path[q * 25][c] - R.path[q][c]));
  check(`tangent ${i} path`, pd < 1e-9, `max diff ${pd}`);
  check(`tangent ${i} brushed`, T.nBrushed === R.n_brushed, `${T.nBrushed} vs ${R.n_brushed}`);
  let ad = 0, n = 0;
  G.nodeIdx.forEach((id, k) => { const a = T.paintArr[id], b = R.paint_arrival[k]; if ((a < 0) !== (b < 0)) n++; else if (a >= 0) ad = Math.max(ad, Math.abs(a - b)); });
  check(`tangent ${i} paint arrival`, ad < 1e-9 && n === 0, `max diff ${ad}, reach mismatches ${n}`);
  for (const [t, pts] of R.ribbons) {
    const rb = TL.ribbon(T, t); let d = 0;
    pts.forEach((p, q) => { for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(rb.pts[q][c] - p[c])); });
    check(`tangent ${i} ribbon @${t}s`, d < 1e-9, `max diff ${d}`);
  }
});
for (const [t, cam, front] of ref.camera) {
  const c = TL.camera(t), d = Math.max(...c.pos.map((v, i) => Math.abs(v - cam[i])));
  check(`camera/front @${t}s`, d < 1e-12 && Math.abs(TL.front(t) - front) < 1e-12);
}
for (const [t, star, master, lat, focus, shell, quote] of ref.show || []) {
  const sh = TL.shell(t), q = TL.quote(t);
  const ok = Math.abs(TL.star(t) - star) < 1e-12 && Math.abs(TL.master(t) - master) < 1e-12 &&
    Math.abs(TL.latticeLevel(t) - lat) < 1e-12 && Math.abs(TL.focus(t) - focus) < 1e-12 &&
    sh.every((v, i) => Math.abs(v - shell[i]) < 1e-12) && q[0] === quote[0] && Math.abs(q[1] - quote[1]) < 1e-12 && Math.abs(q[2] - quote[2]) < 1e-12;
  check(`star/master/afterglow/focus/shell/quote @${t}s`, ok);
}
for (const [t, pts, inten] of ref.meteor || []) {
  const m = TL.meteor(t); let d = 0;
  pts.forEach((p, q) => { for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(m.pts[q][c] - p[c])); d = Math.max(d, Math.abs(m.inten[q] - inten[q])); });
  check(`meteor @${t}s`, d < 1e-9, `max diff ${d}`);
}
console.log(fails ? `${fails} FAILED` : "ALL MATCH");
process.exit(fails ? 1 : 0);
