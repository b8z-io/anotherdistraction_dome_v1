/* Another Distraction — playground UI + WebGL2 renderer.
 * Uses Core (core.js) for the lattice and timeline, and the real
 * shaders/lattice.frag (converted to GLSL ES 3.00 at build time). */
(() => {
  "use strict";
  const $ = (s, el = document) => el.querySelector(s);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const DEFAULTS = JSON.parse($("#params-default").textContent);
  const FRAG = $("#frag-src").textContent;
  const POST = $("#post-src").textContent;
  const QMETA = JSON.parse($("#quote-meta").textContent);
  const STORE = "anotherdistraction.playground.params.v3";
  const hsv = (hd) => { const f = (n) => { const k = (n + hd / 60) % 6; return 1 - 0.92 * Math.max(0, Math.min(k, 4 - k, 1)); }; return [f(5), f(3), f(1)].map((x) => +x.toFixed(3)); };
  const PALETTE = [40, 322, 95, 275, 15, 165, 60, 340, 120, 292, 26, 182, 352, 72, 310, 140].map(hsv);

  // ---------------------------------------------------------------- state
  // a saved draft from an older version may be missing newer settings: fill them from the defaults
  const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
  function fillDefaults(p, d) {
    for (const k of Object.keys(d)) {
      if (!(k in p)) p[k] = clone(d[k]);
      else if (isObj(d[k]) && isObj(p[k])) fillDefaults(p[k], d[k]);
    }
    if (Array.isArray(p.tangents) && DEFAULTS.tangents && DEFAULTS.tangents.length)
      p.tangents.forEach((T, n) => fillDefaults(T, DEFAULTS.tangents[Math.min(n, DEFAULTS.tangents.length - 1)]));
    return p;
  }
  let P = clone(DEFAULTS), restored = false;
  try {
    const s = localStorage.getItem(STORE);
    if (s) { P = fillDefaults(JSON.parse(s), DEFAULTS); restored = true; }
  } catch (e) { P = clone(DEFAULTS); restored = false; /* storage unavailable or unreadable: start from the repo's params */ }

  const getp = (o, path) => path.split(".").reduce((a, k) => (a == null ? a : a[k]), o);
  const setp = (o, path, v) => {
    const ks = path.split("."), last = ks.pop();
    const tgt = ks.reduce((a, k) => a[k], o);
    tgt[last] = v;
  };

  // params that change the graph or the tangents' paths need a rebuild; the rest are live uniforms
  const STRUCTURAL = [/^seed$/, /^lattice\.(cell|site_density|edge_weight_range|crosslink_density|rotation_deg|audience_void_radius|extent)/,
    /^seed_point\.position/, /^growth\./, /^camera\.(x|y|z|yaw)_keys/, /^paint\.brush_/, /^tangents$/,
    /^tangents\.\d+\.(launch_s|flight_s|from_dir|out_dir|out_dist|loop_radius|land_dir|trail|spread_speed|spread_limit)/];
  const isStructural = (path) => STRUCTURAL.some((re) => re.test(path));

  // ---------------------------------------------------------------- WebGL2 renderer
  class DomeRenderer {
    constructor(canvas) {
      this.canvas = canvas;
      const gl = canvas.getContext("webgl2", { antialias: false, preserveDrawingBuffer: true });
      if (!gl) throw new Error("This browser has no WebGL2, so the live preview can't run. Try a current Chrome, Safari or Firefox.");
      this.gl = gl;
      const sh = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error("Shader error: " + gl.getShaderInfoLog(s));
        return s;
      };
      const link = (fsrc) => {
        const prog = gl.createProgram();
        gl.attachShader(prog, sh(gl.VERTEX_SHADER, "#version 300 es\nin vec2 in_pos; void main(){ gl_Position = vec4(in_pos,0,1); }"));
        gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fsrc));
        gl.bindAttribLocation(prog, 0, "in_pos");
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error("Shader link error: " + gl.getProgramInfoLog(prog));
        return prog;
      };
      const prog = link(FRAG);
      this.prog = prog;
      // depth of field needs a float render target; without one the picture is tonemapped in one pass, unblurred
      this.floatOK = !!gl.getExtension("EXT_color_buffer_float");
      if (this.floatOK) { this.post = link(POST); this.ploc = {}; this.hdr = gl.createTexture(); this.fbo = gl.createFramebuffer(); this.hdrSize = [0, 0]; }
      gl.useProgram(prog);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      this.loc = {};
      this.tex = [];
      // the credo's typeset texture (same file render.py uses), on unit 9
      const qt = gl.createTexture(), img = new Image();
      img.onload = () => {
        gl.activeTexture(gl.TEXTURE9);
        gl.bindTexture(gl.TEXTURE_2D, qt);
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        this.onTexture && this.onTexture();
      };
      img.src = $("#quote-png").textContent.trim();
    }
    L(name) {
      if (!(name in this.loc)) this.loc[name] = this.gl.getUniformLocation(this.prog, name);
      return this.loc[name];
    }
    PL(name) {
      if (!(name in this.ploc)) this.ploc[name] = this.gl.getUniformLocation(this.post, name);
      return this.ploc[name];
    }
    upload(TL) {
      const gl = this.gl, N = TL.G.N;
      const arrays = [TL.G.tex, ...TL.paintTex];
      arrays.forEach((data, unit) => {
        if (!this.tex[unit]) this.tex[unit] = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_3D, this.tex[unit]);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA32F, N, N, N, 0, gl.RGBA, gl.FLOAT, data);
      });
    }
    draw(P, TL, t, opt) {
      const gl = this.gl, c = this.canvas;
      const w = opt.proj === 1 ? opt.res * 2 : opt.res, h = opt.res;
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      gl.useProgram(this.prog);
      gl.viewport(0, 0, w, h);
      const f = (n, v) => { const l = this.L(n); if (l) gl.uniform1f(l, v); };
      const i = (n, v) => { const l = this.L(n); if (l) gl.uniform1i(l, v); };
      const v2 = (n, v) => { const l = this.L(n); if (l) gl.uniform2f(l, v[0], v[1]); };
      const v3 = (n, v) => { const l = this.L(n); if (l) gl.uniform3f(l, v[0], v[1], v[2]); };
      const m3 = (n, m) => { const l = this.L(n); if (l) gl.uniformMatrix3fv(l, false, [0, 1, 2].flatMap((col) => [m[0][col], m[1][col], m[2][col]])); };
      const fv = (n, a) => { const l = this.L(n); if (l) gl.uniform1fv(l, a); };
      const v3v = (n, a) => { const l = this.L(n); if (l) gl.uniform3fv(l, a.flat()); };
      const v4v = (n, a) => { const l = this.L(n); if (l) gl.uniform4fv(l, a.flat()); };
      const pad16 = (xs, fill) => xs.concat(new Array(16 - xs.length).fill(fill));
      const o = P.output, L = P.lattice, S = P.seed_point, look = P.look, R = P.render, C = P.camera, PT = P.paint;
      const G = TL.G, Tn = TL.tangents, Pt = P.tangents || [], SH = P.show || {}, NV = P.nova || {}, Q = P.quote, ME = P.meteor;
      const live = (k) => Tn.map((T, n) => (Pt[n] && Pt[n][k] !== undefined ? Pt[n][k] : T[k]));
      ["intensity", "absorb_s", "pulse", "width", "head_glow", "head_size", "flash_size", "color", "hue_spread_deg", "hue_time_s", "fade_s"]
        .forEach((k) => live(k).forEach((v, n) => { Tn[n][k] = v; }));
      i("uGraph", 0);
      for (let u = 0; u < 8; u++) i("uPaint" + u, 1 + u);
      i("uText", 9);
      v2("uRes", [w, h]); i("uProj", opt.proj); f("uFov", o.fov_deg); f("uTilt", o.tilt_deg); i("uSS", opt.ss);
      f("uSeed", P.seed); f("uVoidIn", C.void_inner); f("uVoidOut", C.void_outer);
      m3("uLatRot", G.rot); f("uCell", L.cell); f("uStrutR", L.strut_radius); f("uNodeR", L.node_radius);
      i("uGridH", G.H); f("uExtent", L.extent); f("uXDelay", L.crosslink_delay);
      v3("uSeedPos", G.rootWorld); f("uStarSize", S.star_size_rad);
      i("uNumT", Tn.length);
      v4v("uSpCol", pad16(Tn.map((T) => [...T.color, T.launch_s]), [0, 0, 0, 1e9]));
      v4v("uSpA", pad16(Tn.map((T) => [T.land_s, T.hue_spread_deg * Math.PI / 180, T.hue_time_s, TL.pulse(T, t)]), [0, 0, 1, 0]));
      v4v("uSpB", pad16(Tn.map((T) => [...(T.fade_s || [0, 0]), 0, 0]), [0, 0, 0, 0]));
      f("uSoftT", PT.fade_in_s); f("uPulseT", PT.pulse_s); f("uTintAmt", PT.tint_amount);
      f("uHueJitter", PT.hue_jitter_deg * Math.PI / 180); f("uVivid", PT.vivid);
      i("uFocusIdx", SH.focus_tangent ?? -1); f("uFocus", TL.focus(t));
      f("uMaster", TL.master(t)); f("uLatLevel", TL.latticeLevel(t));
      f("uNovaT", NV.t ?? 1e9); f("uNovaHue", NV.hue_per_path ?? 0); f("uNovaLevel", NV.level ?? 0.6);
      const shl = TL.shell(t); v4v("uShell", [[...shl, 0]]);
      v3("uColDeep", look.col_deep); v3("uColStrut", look.col_strut); v3("uColTip", look.col_tip);
      f("uGlow", look.glow); f("uGlowW", look.glow_width); f("uTipGlow", look.tip_glow);
      f("uFogDist", look.fog_distance); f("uExposure", look.exposure);
      i("uSteps", R.steps); f("uFar", R.far);
      // the credo
      const [card, ca, cr] = TL.quote(t);
      if (Q && card >= 0 && card < QMETA.cards.length) {
        const rad = Q.deg_per_px * Math.PI / 180, rect = QMETA.cards[card], crect = QMETA.credit;
        const drop = (rect[3] / 2 + crect[3] / 2) * rad * 180 / Math.PI + Q.credit_gap_deg;
        const screen = o.fov_deg * Math.PI / 180 / h / Math.max(opt.ss, 1);
        v2("uTextSize", QMETA.size); v4v("uTextRect", [rect]); v4v("uCreditRect", [crect]);
        v3("uTextDir", Core.dirFrom(Q.dir[0], Q.dir[1])); v3("uCreditDir", Core.dirFrom(Q.dir[0], Q.dir[1] - drop));
        v2("uTextAlpha", [ca, cr]); f("uTextRad", rad); f("uTextLod", Math.max(0, Math.log2(screen / rad)));
        v3("uTextCol", Q.color.map((x) => x * Q.level)); f("uTextHalo", Q.halo);
      } else v2("uTextAlpha", [0, 0]);
      // per frame
      const cam = TL.camera(t);
      f("uFront", TL.front(t)); f("uStar", TL.star(t)); v3("uCamPos", cam.pos); m3("uCamRot", cam.R); f("uTime", t);
      const rib = new Array(96).fill(null).map(() => [0, 0, 0, 0]);
      const ribcol = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
      const flash = new Array(8).fill(null).map(() => [0, 0, 0, 0]);
      const flashcol = new Array(8).fill(null).map(() => [0, 0, 0, 1]);
      let slot = 0, fslot = 0;
      for (const T of Tn) {
        const r = TL.ribbon(T, t);
        if (r && slot < 4) {
          r.pts.forEach((p, q) => { rib[slot * 24 + q] = [p[0], p[1], p[2], r.inten[q]]; });
          ribcol[slot] = [...T.color, T.width];
          slot++;
          if (t < T.land_s && fslot < 8) {
            const hd = r.pts[r.pts.length - 1];
            flash[fslot] = [...hd, T.head_glow]; flashcol[fslot] = [...T.color, T.head_size]; fslot++;
          }
        }
        const fl = TL.flash(T, t);
        if (fl > 0.01 && fslot < 8) { flash[fslot] = [...T.land, fl]; flashcol[fslot] = [...T.color, T.flash_size]; fslot++; }
      }
      const m = TL.meteor(t);
      if (m && slot < 4) {
        m.pts.forEach((p, q) => { rib[slot * 24 + q] = [p[0], p[1], p[2], m.inten[q]]; });
        ribcol[slot] = [...ME.color, ME.width]; slot++;
        if (fslot < 8) { flash[fslot] = [...m.pts[m.pts.length - 1], ME.head_glow * m.inten[m.inten.length - 1] / Math.max(ME.intensity, 1e-6)]; flashcol[fslot] = [...ME.color, ME.head_size]; fslot++; }
      }
      i("uNumRib", slot); v4v("uRib", rib); v4v("uRibCol", ribcol); v4v("uFlash", flash); v4v("uFlashCol", flashcol);
      // depth of field: a bubble of focus around the newest coloured blob
      const D = P.dof || {}, [fpos, fstr] = TL.dof(t);
      v3("uFocusPos", fpos); v2("uFocusR", [D.sharp_radius ?? 4, D.soft_radius ?? 16]);
      if (!this.floatOK) { i("uDirect", 1); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); return; }
      i("uDirect", 0);
      gl.activeTexture(gl.TEXTURE10);
      gl.bindTexture(gl.TEXTURE_2D, this.hdr);
      if (this.hdrSize[0] !== w || this.hdrSize[1] !== h) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.hdr, 0);
        this.hdrSize = [w, h];
      }
      gl.bindTexture(gl.TEXTURE_2D, null);                 // not bound while it's being drawn into
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const pxPerDeg = h / (opt.proj === 1 ? 180 : o.fov_deg);
      const cocMax = (D.max_deg ?? 0) * fstr * pxPerDeg;
      gl.bindTexture(gl.TEXTURE_2D, this.hdr);
      if (cocMax > 0) { gl.generateMipmap(gl.TEXTURE_2D); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); }
      else gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.useProgram(this.post);
      const pf = (n, v) => { const l = this.PL(n); if (l) gl.uniform1f(l, v); };
      const pi = (n, v) => { const l = this.PL(n); if (l) gl.uniform1i(l, v); };
      pi("uSrc", 10); const lr = this.PL("uRes"); if (lr) gl.uniform2f(lr, w, h);
      pf("uCocMax", cocMax); pi("uTaps", D.taps ?? 64); pi("uMaskCircle", opt.proj === 1 ? 0 : 1);
      pf("uExposure", look.exposure); pf("uMaster", TL.master(t)); pf("uSeed", P.seed);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }

  // ---------------------------------------------------------------- DOM helpers
  function h(tag, attrs = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "class") el.className = v;
      else if (k === "html") el.innerHTML = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
    return el;
  }
  const fmt = (v, step) => {
    const d = step >= 1 ? 0 : Math.min(4, Math.max(0, Math.ceil(-Math.log10(step))));
    return Number(v).toFixed(d);
  };
  const toHex = (c) => "#" + c.map((x) => Math.round(Math.min(Math.max(x, 0), 1) * 255).toString(16).padStart(2, "0")).join("");
  const fromHex = (s) => [1, 3, 5].map((i) => Math.round(parseInt(s.slice(i, i + 2), 16) / 255 * 1000) / 1000);
  let uid = 0;

  // ---------------------------------------------------------------- app state
  const canvas = $("#dome"), overlay = $("#overlay");
  const ui = {
    t: 0, playing: false, speed: 1, res: 384, ss: 1, proj: 0, guides: true, loop: true,
    status: $("#status"), err: $("#err"), time: $("#time"), scrub: $("#scrub"), stats: $("#stats"),
  };
  let renderer = null, TL = null, dirty = true, rebuildTimer = null, lastFrame = 0, fpsCount = 0, fpsT0 = 0;
  const onChangeHooks = [];

  function saveDraft() {
    try { localStorage.setItem(STORE, JSON.stringify(P)); } catch (e) { /* not stored */ }
  }

  function setStatus(msg, kind = "") { ui.status.textContent = msg; ui.status.dataset.kind = kind; }
  function showError(msg) { ui.err.hidden = !msg; ui.err.textContent = msg || ""; }

  function rebuild() {
    clearTimeout(rebuildTimer);
    setStatus("Regrowing lattice…", "busy");
    // let the status paint before the (synchronous) build
    requestAnimationFrame(() => setTimeout(() => {
      const t0 = performance.now();
      try {
        const next = new Core.Timeline(P);
        TL = next;
        if (renderer) renderer.upload(TL);
        showError("");
        setStatus(`Built in ${Math.round(performance.now() - t0)} ms`, "ok");
        updateTimelineUI();
      } catch (e) {
        showError(e.message);
        setStatus("Kept the last working version", "warn");
      }
      dirty = true;
    }, 0));
  }
  function scheduleRebuild() { clearTimeout(rebuildTimer); rebuildTimer = setTimeout(rebuild, 220); }

  function changed(path) {
    saveDraft();
    refreshModified();
    if (isStructural(path)) scheduleRebuild();
    dirty = true;
    onChangeHooks.forEach((fn) => fn(path));
  }

  // ---------------------------------------------------------------- controls
  const controls = [];   // {path, el, refresh()}
  function modifiedPath(path) {
    return JSON.stringify(getp(P, path)) !== JSON.stringify(getp(DEFAULTS, path));
  }
  function refreshModified() {
    let n = 0;
    for (const c of controls) {
      const m = getp(DEFAULTS, c.path) !== undefined && modifiedPath(c.path);
      c.el.classList.toggle("mod", m);
      if (m) n++;
    }
    $("#modcount").textContent = n ? `${n} changed` : "matches the repo";
    $("#modcount").dataset.mod = n ? "1" : "0";
  }

  function rowShell(label, help, path, body) {
    const id = "c" + (++uid);
    const reset = h("button", { class: "reset", type: "button", title: "Reset to the repo value", "aria-label": `Reset ${label}`,
      onclick: () => { setp(P, path, clone(getp(DEFAULTS, path))); refreshAll(); changed(path); } }, "↺");
    const el = h("div", { class: "row" },
      h("div", { class: "lab" }, h("label", { for: id }, label), reset),
      body(id),
      help ? h("p", { class: "help" }, help) : null);
    return el;
  }

  function range(path, label, o) {
    let num, rng;
    const el = rowShell(label, o.help, path, (id) => h("div", { class: "ctl" },
      rng = h("input", { type: "range", id, min: o.min, max: o.max, step: o.step,
        oninput: () => { num.value = fmt(rng.value, o.step); setp(P, path, Number(rng.value)); changed(path); } }),
      num = h("input", { type: "number", class: "num", min: o.min, max: o.max, step: o.step, "aria-label": label,
        onchange: () => { const v = Number(num.value); if (!isFinite(v)) return; setp(P, path, v); rng.value = v; changed(path); } }),
      h("span", { class: "unit" }, o.unit || "")));
    const refresh = () => { const v = getp(P, path); rng.value = v; num.value = fmt(v, o.step); };
    refresh();
    controls.push({ path, el, refresh });
    return el;
  }

  function color(path, label, help) {
    let inp, code;
    const el = rowShell(label, help, path, (id) => h("div", { class: "ctl" },
      inp = h("input", { type: "color", id, oninput: () => { const v = fromHex(inp.value); setp(P, path, v); code.textContent = v.join(", "); changed(path); } }),
      code = h("code", { class: "rgb" })));
    const refresh = () => { const v = getp(P, path); inp.value = toHex(v); code.textContent = v.map((x) => +x.toFixed(3)).join(", "); };
    refresh();
    controls.push({ path, el, refresh });
    return el;
  }

  function text(path, label, help, parse = (s) => s, show = (v) => v) {
    let inp;
    const el = rowShell(label, help, path, (id) => h("div", { class: "ctl" },
      inp = h("input", { type: "text", id, class: "txt", spellcheck: "false",
        onchange: () => { try { setp(P, path, parse(inp.value)); inp.classList.remove("bad"); changed(path); } catch (e) { inp.classList.add("bad"); } } })));
    const refresh = () => { inp.value = show(getp(P, path)); };
    refresh();
    controls.push({ path, el, refresh });
    return el;
  }
  const notes = (path, label, help) => text(path, label, help,
    (s) => { const a = s.split(/[\s,]+/).filter(Boolean); if (!a.every((x) => /^[A-G][#b]?[0-8]$/.test(x))) throw 0; return a; },
    (v) => v.join(" "));

  function select(path, label, help, options) {
    let sel;
    const el = rowShell(label, help, path, (id) => h("div", { class: "ctl" },
      sel = h("select", { id, onchange: () => { const v = options.find((x) => String(x[0]) === sel.value)[0]; setp(P, path, v); changed(path); } },
        options.map(([v, lab]) => h("option", { value: String(v) }, lab)))));
    const refresh = () => { sel.value = String(getp(P, path)); };
    refresh();
    controls.push({ path, el, refresh });
    return el;
  }

  // keyframe curve editor: drag points, double-click to add or remove
  function keys(path, label, o) {
    const W = 340, H = 104, pad = { l: 34, r: 8, t: 8, b: 18 };
    let svg, list;
    const tmax = () => Math.max(o.tmax, ...getp(P, path).map((k) => k[0] + 5), TL ? TL.end() : 0);
    const X = (t) => pad.l + (t / tmax()) * (W - pad.l - pad.r);
    const Y = (v) => pad.t + (1 - (v - o.vmin) / (o.vmax - o.vmin)) * (H - pad.t - pad.b);
    const invX = (x) => Math.max(0, (x - pad.l) / (W - pad.l - pad.r) * tmax());
    const invY = (y) => Math.min(o.vmax, Math.max(o.vmin, o.vmin + (1 - (y - pad.t) / (H - pad.t - pad.b)) * (o.vmax - o.vmin)));
    const NS = "http://www.w3.org/2000/svg";
    const s = (tag, a) => { const e = document.createElementNS(NS, tag); for (const k in a) e.setAttribute(k, a[k]); return e; };
    function draw() {
      const ks = getp(P, path);
      svg.replaceChildren();
      for (const v of [o.vmin, (o.vmin + o.vmax) / 2, o.vmax]) {
        svg.append(s("line", { x1: pad.l, x2: W - pad.r, y1: Y(v), y2: Y(v), class: "grid" }));
        const tx = s("text", { x: pad.l - 4, y: Y(v) + 3, class: "axis", "text-anchor": "end" }); tx.textContent = +v.toFixed(1); svg.append(tx);
      }
      const tm = tmax(), step = tm > 200 ? 60 : 30;
      for (let t = 0; t <= tm; t += step) {
        svg.append(s("line", { x1: X(t), x2: X(t), y1: pad.t, y2: H - pad.b, class: "grid" }));
        const tx = s("text", { x: X(t), y: H - 5, class: "axis", "text-anchor": "middle" }); tx.textContent = `${t}s`; svg.append(tx);
      }
      let d = "";
      const curve = o.linear ? Core.lerpKeys : Core.pchip;
      for (let q = 0; q <= 320; q++) { const t = q / 320 * tm; d += (q ? "L" : "M") + X(t).toFixed(1) + "," + Y(curve(ks, t)).toFixed(1); }
      svg.append(s("path", { d, class: "curve" }));
      svg.append(s("line", { x1: X(ui.t), x2: X(ui.t), y1: pad.t, y2: H - pad.b, class: "playhead" }));
      ks.forEach((k, n) => {
        const pt = s("circle", { cx: X(k[0]), cy: Y(k[1]), r: 5, class: "key", tabindex: 0 });
        pt.addEventListener("pointerdown", (ev) => {
          ev.preventDefault(); pt.setPointerCapture(ev.pointerId);
          const move = (e) => {
            const r = svg.getBoundingClientRect(), sx = W / r.width;
            k[0] = Math.round(invX((e.clientX - r.left) * sx) * 10) / 10;
            k[1] = Math.round(invY((e.clientY - r.top) * (H / r.height)) * 100) / 100;
            draw(); listRefresh(); changed(path);
          };
          const up = () => { pt.removeEventListener("pointermove", move); pt.removeEventListener("pointerup", up); };
          pt.addEventListener("pointermove", move); pt.addEventListener("pointerup", up);
        });
        pt.addEventListener("dblclick", (ev) => {
          ev.stopPropagation();
          if (ks.length > (o.minKeys || 1)) { ks.splice(n, 1); draw(); listRefresh(); changed(path); }
        });
        svg.append(pt);
      });
    }
    const listRefresh = () => { list.value = getp(P, path).map((k) => `${+k[0].toFixed(2)}:${+k[1].toFixed(3)}`).join("  "); };
    const el = rowShell(label, o.help, path, (id) => h("div", { class: "keys" },
      svg = s("svg", { viewBox: `0 0 ${W} ${H}`, class: "kchart", role: "img", "aria-label": `${label} over time` }),
      list = h("input", { type: "text", id, class: "txt klist", spellcheck: "false", title: "time:value pairs",
        onchange: () => {
          try {
            const ks = list.value.trim().split(/\s+/).map((p) => p.split(":").map(Number));
            if (!ks.length || ks.some((k) => k.length !== 2 || !k.every(isFinite))) throw 0;
            if (ks.length < (o.minKeys || 1)) throw 0;
            setp(P, path, ks.sort((a, b) => a[0] - b[0])); list.classList.remove("bad"); draw(); changed(path);
          } catch (e) { list.classList.add("bad"); }
        } })));
    svg.addEventListener("dblclick", (ev) => {
      const r = svg.getBoundingClientRect();
      const t = Math.round(invX((ev.clientX - r.left) * W / r.width) * 10) / 10;
      const v = Math.round(invY((ev.clientY - r.top) * H / r.height) * 100) / 100;
      const ks = getp(P, path); ks.push([t, v]); ks.sort((a, b) => a[0] - b[0]); draw(); listRefresh(); changed(path);
    });
    const refresh = () => { draw(); listRefresh(); };
    refresh();
    controls.push({ path, el, refresh, draw });
    return el;
  }

  // dome direction picker: from / out / land on a little domemaster
  function domePicker(ti) {
    const S = 168, R = 74, cx = S / 2, cy = S / 2;
    const marks = [["from_dir", "From", "◯"], ["out_dir", "Out to", "◆"], ["land_dir", "Lands", "●"]];
    let cv, dragging = null, readout;
    const pos = (d) => { const r = (90 - d[1]) / 90 * R, a = d[0] * Math.PI / 180; return [cx + Math.sin(a) * r, cy + Math.cos(a) * r]; };
    const dirAt = (x, y) => {
      const dx = x - cx, dy = y - cy, r = Math.min(Math.hypot(dx, dy), R);
      return [Math.round(Math.atan2(dx, dy) * 180 / Math.PI), Math.round(90 - r / R * 90)];
    };
    function paint() {
      const T = P.tangents[ti]; if (!T) return;
      const g = cv.getContext("2d"), dpr = window.devicePixelRatio || 1;
      cv.width = S * dpr; cv.height = S * dpr; g.scale(dpr, dpr);
      const css = getComputedStyle(document.documentElement);
      g.fillStyle = css.getPropertyValue("--well"); g.beginPath(); g.arc(cx, cy, R, 0, 7); g.fill();
      g.strokeStyle = css.getPropertyValue("--line"); g.lineWidth = 1;
      for (const el of [0, 30, 60]) { g.beginPath(); g.arc(cx, cy, (90 - el) / 90 * R, 0, 7); g.stroke(); }
      for (let a = 0; a < 360; a += 45) { const r = a * Math.PI / 180; g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.sin(r) * R, cy + Math.cos(r) * R); g.stroke(); }
      g.fillStyle = css.getPropertyValue("--muted"); g.font = "600 9px 'IBM Plex Mono', monospace"; g.textAlign = "center";
      g.fillText("FRONT", cx, cy + R + 11); g.fillText("BEHIND", cx, cy - R - 4);
      g.textAlign = "left"; g.fillText("R", cx + R + 3, cy + 3); g.textAlign = "right"; g.fillText("L", cx - R - 3, cy + 3);
      const col = toHex(T.color);
      const pts = marks.map(([k]) => pos(T[k]));
      g.strokeStyle = col; g.globalAlpha = 0.5; g.setLineDash([3, 3]); g.beginPath();
      pts.forEach((p, n) => (n ? g.lineTo(...p) : g.moveTo(...p))); g.stroke(); g.setLineDash([]); g.globalAlpha = 1;
      marks.forEach(([k, , glyph], n) => {
        const [x, y] = pts[n];
        g.fillStyle = col; g.strokeStyle = col; g.lineWidth = 2;
        g.beginPath();
        if (n === 0) { g.arc(x, y, 6, 0, 7); g.stroke(); }
        else if (n === 1) { g.moveTo(x, y - 7); g.lineTo(x + 7, y); g.lineTo(x, y + 7); g.lineTo(x - 7, y); g.closePath(); g.fill(); }
        else { g.arc(x, y, 6, 0, 7); g.fill(); }
      });
      readout.replaceChildren(...marks.map(([k, lab, glyph]) =>
        h("span", {}, h("b", {}, `${glyph} ${lab}`), ` az ${T[k][0]}°, el ${T[k][1]}°`)));
    }
    const xy = (ev) => { const r = cv.getBoundingClientRect(); return [(ev.clientX - r.left) * S / r.width, (ev.clientY - r.top) * S / r.height]; };
    const wrap = h("div", { class: "picker" },
      cv = h("canvas", { width: S, height: S, style: `width:${S}px;height:${S}px`, role: "img",
        "aria-label": "Where on the dome this tangent breaks away, swings out to and lands. Drag the markers." }),
      readout = h("div", { class: "readout" }));
    cv.addEventListener("pointerdown", (ev) => {
      const T = P.tangents[ti], [x, y] = xy(ev);
      let best = 1e9;
      marks.forEach(([k]) => { const [px, py] = pos(T[k]); const d = Math.hypot(px - x, py - y); if (d < best) { best = d; dragging = k; } });
      if (best > 22) { dragging = null; return; }
      cv.setPointerCapture(ev.pointerId);
    });
    cv.addEventListener("pointermove", (ev) => {
      if (!dragging) return;
      const T = P.tangents[ti]; T[dragging] = dirAt(...xy(ev)); paint();
      controls.filter((c) => c.path.startsWith(`tangents.${ti}.${dragging}`)).forEach((c) => c.refresh());
      changed(`tangents.${ti}.${dragging}`);
    });
    cv.addEventListener("pointerup", () => { dragging = null; });
    onChangeHooks.push((p) => { if (p.startsWith(`tangents.${ti}.`) || p === "tangents") paint(); });
    requestAnimationFrame(paint);
    return wrap;
  }

  // ---------------------------------------------------------------- the panel
  function group(title, sub, ...rows) {
    const d = h("details", { class: "grp" }, h("summary", {}, h("span", { class: "gt" }, title), sub ? h("span", { class: "gs" }, sub) : null), h("div", { class: "rows" }, rows));
    return d;
  }
  const dirRow = (path, label, help) => h("div", { class: "pair" },
    range(path + ".0", label + " · azimuth", { min: -180, max: 180, step: 1, unit: "°", help }),
    range(path + ".1", label + " · elevation", { min: 0, max: 90, step: 1, unit: "°" }));

  function tangentCard(ti) {
    const T = P.tangents[ti], b = `tangents.${ti}`;
    const sw = h("span", { class: "sw", style: `background:${toHex(T.color)}` });
    onChangeHooks.push((p) => { if (P.tangents[ti]) sw.style.background = toHex(P.tangents[ti].color); });
    const card = h("details", { class: "tcard", open: ti === 0 },
      h("summary", {}, sw, h("span", { class: "gt" }, T.name || `Tangent ${ti + 1}`),
        h("span", { class: "gs" }, `${T.launch_s}s → lands ${(T.launch_s + T.flight_s).toFixed(1)}s`)),
      h("div", { class: "tbar" },
        h("button", { type: "button", onclick: () => seek(P.tangents[ti].launch_s - 1.5) }, "Go to launch"),
        h("button", { type: "button", onclick: () => seek(P.tangents[ti].launch_s + P.tangents[ti].flight_s - 0.3) }, "Go to landing"),
        h("button", { type: "button", onclick: () => duplicateTangent(ti) }, "Duplicate"),
        h("button", { type: "button", class: "danger", onclick: () => removeTangent(ti) }, "Remove")),
      h("div", { class: "rows" },
        text(`${b}.name`, "Name", "A label for you; not used in the render."),
        color(`${b}.color`, "Colour", "Its own hue. Keep each tangent different and clear of the lattice's blue."),
        h("h4", {}, "When"),
        range(`${b}.launch_s`, "Launch", { min: 0, max: 300, step: 0.5, unit: "s", help: "When it peels off a node." }),
        range(`${b}.flight_s`, "Flight", { min: 2, max: 30, step: 0.5, unit: "s", help: "How long it flies before landing." }),
        range(`${b}.absorb_s`, "Absorb", { min: 0.5, max: 8, step: 0.1, unit: "s", help: "How long the tail takes to sink in after landing." }),
        h("h4", {}, "Where"),
        domePicker(ti),
        dirRow(`${b}.from_dir`, "From", "Roughly where it breaks away (the nearest grown node is used)."),
        dirRow(`${b}.out_dir`, "Out to", "Where it swings out to — try behind the audience."),
        dirRow(`${b}.land_dir`, "Lands", "Roughly where it lands."),
        range(`${b}.out_dist`, "Out distance", { min: 6, max: 34, step: 0.5, help: "How far out it swings." }),
        range(`${b}.loop_radius`, "Loop size", { min: 0, max: 10, step: 0.1, help: "Size of the loop it makes out there." }),
        h("h4", {}, "Comet"),
        range(`${b}.intensity`, "Brightness", { min: 0, max: 14, step: 0.1 }),
        range(`${b}.width`, "Width", { min: 0.02, max: 0.4, step: 0.005 }),
        range(`${b}.trail`, "Trail length", { min: 1, max: 24, step: 0.5, help: "Length of the ribbon behind the head." }),
        range(`${b}.head_glow`, "Head glow", { min: 0, max: 20, step: 0.1 }),
        range(`${b}.head_size`, "Head size", { min: 0.05, max: 1.5, step: 0.01 }),
        range(`${b}.flash_size`, "Landing flash size", { min: 0.1, max: 2.5, step: 0.05 }),
        h("h4", {}, "Paint"),
        range(`${b}.fade_s.0`, "Colour recedes from", { min: 0, max: 300, step: 0.5, unit: "s", help: "Optional: when this comet's colour starts to drain away (hyperfocus washing out)." }),
        range(`${b}.fade_s.1`, "…over", { min: 0, max: 30, step: 0.5, unit: "s", help: "0 = the colour stays." }),
        range(`${b}.spread_speed`, "Spread speed", { min: 0.5, max: 20, step: 0.1, help: "How fast its colour travels through the lattice from where it lands (path units/s)." }),
        range(`${b}.spread_limit`, "Spread reach", { min: 4, max: 90, step: 1, help: "How far the stain can reach (path units)." }),
        range(`${b}.pulse`, "Wavefront glow", { min: 0, max: 8, step: 0.1, help: "Brightness of the travelling edge of the colour." }),
        range(`${b}.hue_spread_deg`, "Hue drift", { min: -120, max: 120, step: 1, unit: "°", help: "How far the stain's hue drifts from the comet's own colour." }),
        range(`${b}.hue_time_s`, "Hue drift time", { min: 0.5, max: 30, step: 0.5, unit: "s", help: "The full drift is reached this long after landing." }),
        h("h4", {}, "Sound (score.py — not previewed here)"),
        range(`${b}.precue_s`, "Pre-cue", { min: 0, max: 4, step: 0.1, unit: "s", help: "How early its sound starts before it appears." }),
        notes(`${b}.sound.motif`, "Motif", "Notes it plays in flight, e.g. A4 D5 E5 F#5."),
        notes(`${b}.sound.chord`, "Chord", "Landing bloom, pad and paint chimes."),
        range(`${b}.sound.motif_level`, "Motif level", { min: 0, max: 0.5, step: 0.01 }),
        range(`${b}.sound.whoosh_level`, "Whoosh level", { min: 0, max: 0.5, step: 0.01 }),
        range(`${b}.sound.bloom_level`, "Bloom level", { min: 0, max: 0.5, step: 0.01 }),
        range(`${b}.sound.thump_level`, "Thump level", { min: 0, max: 0.5, step: 0.01 }),
        range(`${b}.sound.pad_level`, "Pad level", { min: 0, max: 0.5, step: 0.01 })));
    return card;
  }

  function buildPanel() {
    controls.length = 0; onChangeHooks.length = 0;
    const panel = $("#panel-groups");
    panel.replaceChildren(
      group("Seed & output", "the whole piece",
        range("seed", "Seed", { min: 1, max: 9999, step: 1, help: "Picks which lattice grows. Change it for a whole new structure." }),
        range("output.fov_deg", "Field of view", { min: 150, max: 230, step: 1, unit: "°", help: "180 = hemisphere; more for domes that need overscan." }),
        range("output.tilt_deg", "Dome tilt", { min: 0, max: 45, step: 0.5, unit: "°", help: "Tips the zenith toward the front for tilted / unidirectional domes." }),
        select("output.fps", "Frame rate", "Used by render.py and score.py.", [[24, "24"], [25, "25"], [30, "30"], [50, "50"], [60, "60"]]),
        select("output.preview_res", "render.py preview size", "Default square size when --res isn't given.", [[512, "512"], [768, "768"], [1024, "1024"], [2048, "2048"], [4096, "4096"]]),
        select("output.supersample", "render.py supersampling", "Samples per pixel per axis. 2 kills shimmer on thin struts.", [[1, "1×"], [2, "2× (4 samples)"], [3, "3× (9 samples)"]])),
      group("Lattice", "the ordered structure",
        range("lattice.site_density", "Density", { min: 0.15, max: 1, step: 0.01, help: "Fraction of lattice sites that can grow. Lower = sparser, more elegant." }),
        range("lattice.cell", "Cell size", { min: 1, max: 4, step: 0.05, help: "Spacing between nodes (world units; the audience is at the origin)." }),
        range("lattice.edge_weight_range.0", "Strut cost · min", { min: 0.1, max: 3, step: 0.05, help: "Random 'cost' range per strut. Wider = more irregular, wandering growth." }),
        range("lattice.edge_weight_range.1", "Strut cost · max", { min: 0.2, max: 6, step: 0.05 }),
        range("lattice.crosslink_density", "Cross-links", { min: 0, max: 0.6, step: 0.01, help: "Extra struts bridging grown branches. More = crystal, less = tree." }),
        range("lattice.crosslink_delay", "Cross-link delay", { min: 0, max: 30, step: 0.5, help: "How far behind the growth front cross-links appear (path units)." }),
        range("lattice.rotation_deg.0", "Orientation · X", { min: -180, max: 180, step: 0.5, unit: "°" }),
        range("lattice.rotation_deg.1", "Orientation · Y", { min: -180, max: 180, step: 0.5, unit: "°" }),
        range("lattice.rotation_deg.2", "Orientation · Z", { min: -180, max: 180, step: 0.5, unit: "°" }),
        range("lattice.audience_void_radius", "Clear space", { min: 1, max: 14, step: 0.5, help: "Nothing grows closer than this to the audience." }),
        range("lattice.extent", "Extent", { min: 12, max: 48, step: 1, help: "How far out the lattice can ever grow." }),
        range("lattice.strut_radius", "Strut thickness", { min: 0.004, max: 0.08, step: 0.001 }),
        range("lattice.node_radius", "Joint size", { min: 0, max: 0.15, step: 0.002 })),
      group("Seed star", "the opening",
        range("seed_point.position.0", "Position · X (right)", { min: -20, max: 20, step: 0.25 }),
        range("seed_point.position.1", "Position · Y (up)", { min: 2, max: 30, step: 0.25, help: "Where the seed sits — also where growth starts." }),
        range("seed_point.position.2", "Position · Z (behind)", { min: -20, max: 20, step: 0.25 }),
        range("seed_point.star_fade_in_s.0", "Fade-in starts", { min: 0, max: 20, step: 0.1, unit: "s" }),
        range("seed_point.star_fade_in_s.1", "Fade-in ends", { min: 0, max: 30, step: 0.1, unit: "s" }),
        range("seed_point.star_intensity", "Brightness", { min: 0, max: 5, step: 0.05 }),
        range("seed_point.star_size_rad", "Size", { min: 0.001, max: 0.03, step: 0.0005, unit: "rad" }),
        keys("seed_point.star_keys", "Brightness over time", { tmax: 300, vmin: 0, vmax: 10, linear: true,
          help: "Multiplies the star: it flares as everything is pulled in, bursts at the supernova, then goes out." })),
      group("Growth", "how fast the lattice spreads",
        keys("growth.front_keys", "Growth front", { tmax: 300, vmin: 0, vmax: 140, minKeys: 2,
          help: "How far along the branches growth has travelled at each time. Steeper = faster; flat = pauses. Drag points, double-click to add or remove." })),
      group("Camera", "the audience's viewpoint",
        keys("camera.y_keys", "Rise (Y)", { tmax: 300, vmin: -4, vmax: 24, help: "Rising is the gentlest motion on a dome." }),
        keys("camera.yaw_keys", "Turn (yaw)", { tmax: 300, vmin: -90, vmax: 90, help: "Slow turn about the zenith, degrees. Keep it under about 1°/s." }),
        keys("camera.x_keys", "Drift right (X)", { tmax: 300, vmin: -12, vmax: 12 }),
        keys("camera.z_keys", "Drift back (Z)", { tmax: 300, vmin: -12, vmax: 12 }),
        range("camera.void_inner", "Clear bubble", { min: 0.2, max: 6, step: 0.1, help: "Nothing closer than this to the audience." }),
        range("camera.void_outer", "Fade-in distance", { min: 0.5, max: 12, step: 0.1, help: "Struts fade in out to this distance." })),
      group("Look", "light and colour",
        color("look.col_strut", "Near struts", "Raw shader values (0–1), before tone-mapping."),
        color("look.col_deep", "Distance & haze", "The deep blue distant struts and glow sink into."),
        color("look.col_tip", "Growing tips & star"),
        range("look.exposure", "Exposure", { min: 0.2, max: 3, step: 0.01, help: "Keep the dome dark: a concave screen reflects onto itself." }),
        range("look.glow", "Glow", { min: 0, max: 4, step: 0.01 }),
        range("look.glow_width", "Glow width", { min: 0.01, max: 0.3, step: 0.005 }),
        range("look.tip_glow", "Tip glow", { min: 0, max: 8, step: 0.05 }),
        range("look.fog_distance", "Fog distance", { min: 4, max: 60, step: 0.5, help: "How quickly distance fades struts." })),
      group("Show", "the arc of the whole piece",
        range("show.end_s", "Length", { min: 30, max: 600, step: 1, unit: "s" }),
        keys("show.lattice_keys", "Lattice brightness", { tmax: 300, vmin: 0, vmax: 1.2, linear: true,
          help: "The lattice alone — the afterglow cooling and going out after the supernova." }),
        keys("show.focus_keys", "Hyperfocus", { tmax: 300, vmin: 0, vmax: 1, help: "0–1: dims everything except the focus comet's colour." }),
        select("show.focus_tangent", "Focus comet", "Whose colour stays bright during hyperfocus.",
          [[-1, "none"], ...(P.tangents || []).map((T, n) => [n, `${n + 1}. ${T.name}`])]),
        keys("show.master_keys", "Picture level", { tmax: 300, vmin: 0, vmax: 1, linear: true,
          help: "Straight lines: two keys close together make a hard cut to black." }),
        keys("show.audio_keys", "Sound level", { tmax: 300, vmin: 0, vmax: 1, linear: true,
          help: "For score.py (the held breath before the supernova). Not heard here." })),
      group("Depth of field", "focus follows the shiny thing",
        keys("dof.strength_keys", "Strength", { tmax: 300, vmin: 0, vmax: 1, linear: true,
          help: "0 = everything sharp. Off before the first comet and from the supernova on, so the credo stays crisp." }),
        range("dof.sharp_radius", "Sharp within", { min: 0, max: 30, step: 0.5,
          help: "Distance around the newest blob that stays fully sharp (lattice cells are 2 units)." }),
        range("dof.soft_radius", "Fully soft by", { min: 1, max: 60, step: 0.5, help: "Blur grows smoothly out to this distance." }),
        range("dof.max_deg", "Most blur", { min: 0, max: 4, step: 0.05, unit: "°", help: "Size of the softest blur, in degrees of the dome." }),
        range("dof.rack_s", "Focus pull", { min: 0.05, max: 4, step: 0.05, unit: "s", help: "How long focus takes to glide to each new blob." }),
        range("dof.taps", "Blur quality", { min: 8, max: 128, step: 8, help: "Samples per pixel. Lower is faster while you play." })),
      group("Supernova", "the reward",
        range("nova.t", "Burst at", { min: 0, max: 400, step: 0.1, unit: "s",
          help: "Pair it with the growth front: the front drops to 0 just before (the inhale) and races back out after." }),
        range("nova.shell_speed", "Shock-ring speed", { min: 1, max: 40, step: 0.5 }),
        range("nova.shell_width", "Shock-ring width", { min: 0.05, max: 3, step: 0.05 }),
        range("nova.intensity", "Shock-ring brightness", { min: 0, max: 12, step: 0.1 }),
        range("nova.decay_s", "Shock-ring fades over", { min: 0.3, max: 10, step: 0.1, unit: "s" }),
        range("nova.level", "Every-colour brightness", { min: 0, max: 2, step: 0.01, help: "The lattice's colours after the burst." }),
        range("nova.hue_per_path", "Colour rings", { min: 0, max: 0.4, step: 0.005, help: "How fast the hue turns out from the star: rings of colour." })),
      group("Credo", "Jack London, in light",
        dirRow("quote.dir", "Placement", "Centre of the words on the dome."),
        range("quote.deg_per_px", "Text size", { min: 0.01, max: 0.08, step: 0.001, unit: "°/px" }),
        color("quote.color", "Colour"),
        range("quote.level", "Brightness", { min: 0, max: 4, step: 0.01 }),
        range("quote.halo", "Dark halo", { min: 0, max: 1, step: 0.01, help: "Darkens what's behind the words so they stay legible." }),
        range("quote.fade_s", "Fade", { min: 0.1, max: 3, step: 0.05, unit: "s" }),
        range("quote.credit_in", "Credit appears", { min: 0, max: 400, step: 0.1, unit: "s" }),
        range("quote.credit_gap_deg", "Credit gap", { min: 0, max: 15, step: 0.1, unit: "°" }),
        ...(P.quote ? P.quote.cards.flatMap((c, k) => [
          h("h4", {}, `“${c.rows.join(" ")}”`),
          range(`quote.cards.${k}.in`, "Appears", { min: 0, max: 400, step: 0.05, unit: "s" }),
          range(`quote.cards.${k}.voice_at`, "Voice starts", { min: 0, max: 400, step: 0.05, unit: "s", help: "For score.py — your voice isn't played here." }),
          range(`quote.cards.${k}.out`, "Gone by", { min: 0, max: 400, step: 0.05, unit: "s" })]) : [])),
      group("Meteor", "the last distraction",
        range("meteor.t", "At", { min: 0, max: 400, step: 0.1, unit: "s" }),
        range("meteor.dur", "Crossing time", { min: 0.3, max: 6, step: 0.05, unit: "s" }),
        dirRow("meteor.from_dir", "From"),
        dirRow("meteor.to_dir", "To"),
        range("meteor.dist", "Distance", { min: 5, max: 40, step: 0.5 }),
        color("meteor.color", "Colour"),
        range("meteor.width", "Width", { min: 0.01, max: 0.3, step: 0.005 }),
        range("meteor.trail", "Trail", { min: 0.05, max: 1, step: 0.01 }),
        range("meteor.intensity", "Brightness", { min: 0, max: 14, step: 0.1 }),
        range("meteor.head_glow", "Head glow", { min: 0, max: 14, step: 0.1 }),
        range("meteor.head_size", "Head size", { min: 0.05, max: 1.5, step: 0.01 })),
      group("Paint", "how tangents colour the lattice",
        range("paint.brush_radius", "Brush radius", { min: 0, max: 6, step: 0.1, help: "How close the comet's head must pass to paint a node." }),
        range("paint.brush_reach", "Brush bleed", { min: 0.5, max: 12, step: 0.1, help: "How far brushed colour bleeds from there (path units)." }),
        range("paint.brush_speed", "Brush bleed speed", { min: 0.5, max: 20, step: 0.1 }),
        range("paint.fade_in_s", "Colour fade-in", { min: 0.05, max: 4, step: 0.05, unit: "s" }),
        range("paint.pulse_s", "Arrival flash", { min: 0.05, max: 3, step: 0.05, unit: "s", help: "How long a strut flashes as colour reaches it." }),
        range("paint.tint_amount", "Tint amount", { min: 0, max: 1, step: 0.01, help: "How fully colour replaces the cool base." }),
        range("paint.hue_jitter_deg", "Hue variety", { min: 0, max: 90, step: 1, unit: "°", help: "Node-to-node hue variation." }),
        range("paint.vivid", "Vividness", { min: 0.2, max: 3, step: 0.01, help: "Brightness of painted struts." })),
      h("section", { class: "tsec" },
        h("div", { class: "tsec-h" }, h("h3", {}, "Tangents"), h("span", { class: "gs" }, "each one a distraction · max 16"),
          h("button", { type: "button", id: "addT", onclick: addTangent }, "+ Add tangent")),
        h("div", { id: "tcards" }, (P.tangents || []).map((_, i) => tangentCard(i)))),
      group("Sound", "score.py — not previewed here",
        notes("score.drone.notes", "Drone notes", "The lattice's drone, e.g. D2 A2."),
        range("score.drone.level", "Drone level", { min: 0, max: 0.4, step: 0.005 }),
        text("score.drone.star_note", "Star note", "A faint high tone for the seed star."),
        range("score.drone.star_level", "Star level", { min: 0, max: 0.1, step: 0.001 }),
        range("score.pings.level", "Growth pings", { min: 0, max: 0.6, step: 0.01, help: "A tuned bell for every node that switches on." }),
        range("score.paint.level", "Paint chimes", { min: 0, max: 0.6, step: 0.01, help: "Chimes in each tangent's chord as its colour arrives." }),
        range("score.reverb_send.drone", "Reverb send · drone", { min: 0, max: 1.5, step: 0.01 }),
        range("score.reverb_send.pings", "Reverb send · pings", { min: 0, max: 1.5, step: 0.01 }),
        range("score.reverb_send.paint", "Reverb send · paint", { min: 0, max: 1.5, step: 0.01 }),
        range("score.reverb_send.tangents", "Reverb send · tangents", { min: 0, max: 1.5, step: 0.01 }),
        range("score.pad_decay_s", "Pads fade over", { min: 2, max: 120, step: 1, unit: "s" }),
        range("score.pulse.start", "Hyperfocus pulse · from", { min: 0, max: 400, step: 0.5, unit: "s" }),
        range("score.pulse.end", "Hyperfocus pulse · to", { min: 0, max: 400, step: 0.5, unit: "s" }),
        range("score.pulse.bpm", "Hyperfocus pulse · tempo", { min: 40, max: 180, step: 1, unit: "bpm" }),
        notes("score.pulse.notes", "Hyperfocus pulse · notes"),
        range("score.pulse.level", "Hyperfocus pulse · level", { min: 0, max: 0.5, step: 0.005 }),
        range("score.riser.start", "Overload riser · from", { min: 0, max: 400, step: 0.5, unit: "s" }),
        range("score.riser.end", "Overload riser · to", { min: 0, max: 400, step: 0.5, unit: "s" }),
        range("score.riser.level", "Overload riser · level", { min: 0, max: 0.5, step: 0.005 }),
        range("score.inhale.start", "Inhale · from", { min: 0, max: 400, step: 0.1, unit: "s" }),
        range("score.inhale.end", "Inhale · to", { min: 0, max: 400, step: 0.1, unit: "s" }),
        range("score.inhale.level", "Inhale · level", { min: 0, max: 0.6, step: 0.005 }),
        notes("score.nova.chord", "Supernova chord"),
        range("score.nova.level", "Supernova chord level", { min: 0, max: 1, step: 0.01 }),
        range("score.nova.decay_s", "Supernova rings for", { min: 2, max: 40, step: 0.5, unit: "s" }),
        range("score.nova.boom_level", "Supernova boom", { min: 0, max: 1, step: 0.01 }),
        range("score.regrow_chime_level", "Regrowth chimes", { min: 0, max: 0.3, step: 0.005 }),
        range("score.voice.level", "Voice level", { min: 0, max: 4, step: 0.05 }),
        range("score.voice.duck", "Drone dips under voice", { min: 0, max: 1, step: 0.01 }),
        range("score.voice.reverb_send", "Voice reverb", { min: 0, max: 1, step: 0.01 }),
        range("score.reverb_level", "Reverb level", { min: 0, max: 2, step: 0.01 }),
        range("score.master_peak_db", "Master peak", { min: -12, max: 0, step: 0.1, unit: "dB" })),
      group("Render quality", "raymarch limits",
        range("render.steps", "Steps", { min: 40, max: 400, step: 10, help: "More = fewer gaps in distant struts, slower." }),
        range("render.far", "Far limit", { min: 15, max: 90, step: 1 })));
    refreshModified();
  }
  const refreshAll = () => controls.forEach((c) => c.refresh());

  function addTangent() {
    const Ts = P.tangents || (P.tangents = []);
    if (Ts.length >= 16) { showError("The shader takes at most 16 tangents."); return; }
    const last = Ts[Ts.length - 1] || clone(DEFAULTS.tangents[0]);
    const T = clone(last);
    T.name = `tangent ${Ts.length + 1}`;
    T.color = PALETTE[Ts.length % PALETTE.length];
    T.launch_s = +(last.launch_s + last.flight_s + 6).toFixed(1);
    T.from_dir = [((last.land_dir[0] + 200) % 360) - 180, last.land_dir[1]];
    Ts.push(T);
    buildPanel(); openTangent(Ts.length - 1); changed("tangents"); seek(T.launch_s - 1.5);
  }
  function duplicateTangent(i) {
    if (P.tangents.length >= 16) { showError("The shader takes at most 16 tangents."); return; }
    const T = clone(P.tangents[i]);
    T.name += " copy"; T.launch_s = +(T.launch_s + 4).toFixed(1); T.color = PALETTE[P.tangents.length % PALETTE.length];
    P.tangents.splice(i + 1, 0, T);
    buildPanel(); openTangent(i + 1); changed("tangents");
  }
  function removeTangent(i) {
    P.tangents.splice(i, 1);
    buildPanel(); changed("tangents");
  }
  function openTangent(i) {
    const grp = $("#tcards").children[i];
    if (grp) { grp.open = true; grp.scrollIntoView({ block: "nearest" }); }
  }

  // ---------------------------------------------------------------- transport + overlay
  function seek(t) { ui.t = Math.max(0, Math.min(t, Number(ui.scrub.max))); dirty = true; }
  function updateTimelineUI() {
    const end = Math.ceil(Math.max(TL.end(), 30));
    ui.scrub.max = end;
    const marks = $("#marks");
    marks.replaceChildren(...TL.tangents.flatMap((T) => [
      h("span", { class: "mk launch", style: `left:${T.launch_s / end * 100}%;--c:${toHex(T.color)}`, title: `${T.name}: launch ${T.launch_s}s` }),
      h("span", { class: "mk land", style: `left:${T.land_s / end * 100}%;--c:${toHex(T.color)}`, title: `${T.name}: lands ${T.land_s.toFixed(1)}s` })]));
    $("#endt").textContent = clock(end);
    $("#sections").replaceChildren(...((P.show && P.show.sections) || []).filter((x) => x[0] <= end).map(([t0, name]) =>
      h("span", { class: "sec", style: `left:${t0 / end * 100}%`, title: `${clock(t0)} ${name}`, onclick: () => seek(t0) }, name)));
    const brushed = TL.tangents.map((T) => T.nBrushed).join(" / ");
    ui.stats.textContent = `${TL.G.stats.reached.toLocaleString()} nodes · ${TL.tangents.length} tangent${TL.tangents.length === 1 ? "" : "s"}` + (TL.tangents.length ? ` · ${brushed} struts brushed in flight` : "");
  }
  const clock = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;

  function drawOverlay() {
    const g = overlay.getContext("2d");
    const r = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    overlay.width = r.width * dpr; overlay.height = r.height * dpr;
    overlay.style.width = r.width + "px"; overlay.style.height = r.height + "px";
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!ui.guides || ui.proj !== 0) return;
    const cx = r.width / 2, cy = r.height / 2, R = Math.min(cx, cy) * (180 / P.output.fov_deg);
    g.strokeStyle = "rgba(160,190,255,0.22)"; g.lineWidth = 1; g.setLineDash([2, 4]);
    for (const el of [0, 30, 60]) { g.beginPath(); g.arc(cx, cy, (90 - el) / 90 * R, 0, 7); g.stroke(); }
    g.setLineDash([]);
    g.fillStyle = "rgba(190,205,235,0.55)"; g.font = "600 10px 'IBM Plex Mono', monospace"; g.textAlign = "center";
    g.fillText("FRONT", cx, Math.min(cy + R - 8, r.height - 6));
    g.fillText("BEHIND", cx, Math.max(cy - R + 16, 12));
    g.fillText("30°", cx + (60 / 90) * R * 0.71 + 12, cy + (60 / 90) * R * 0.71);
  }

  function frame(now) {
    const dt = Math.min((now - (lastFrame || now)) / 1000, 0.1);
    lastFrame = now;
    if (ui.playing) {
      ui.t += dt * ui.speed;
      const end = Number(ui.scrub.max);
      if (ui.t > end) { if (ui.loop) ui.t = 0; else { ui.t = end; setPlaying(false); } }
      dirty = true;
    }
    if (dirty && TL && renderer) {
      try { renderer.draw(P, TL, ui.t, ui); } catch (e) { showError(e.message); }
      fpsCount++;
      if (now - fpsT0 > 1000) { $("#ms").textContent = ui.playing ? `${Math.round(fpsCount * 1000 / (now - fpsT0))} fps` : "paused"; fpsCount = 0; fpsT0 = now; }
      ui.scrub.value = ui.t;
      ui.time.textContent = clock(ui.t);
      controls.forEach((c) => c.draw && !c.el.closest("details:not([open])") && c.draw());
      dirty = false;
    }
    requestAnimationFrame(frame);
  }
  function setPlaying(p) {
    ui.playing = p;
    const b = $("#play"); b.textContent = p ? "Pause" : "Play"; b.setAttribute("aria-pressed", p ? "true" : "false");
  }

  // ---------------------------------------------------------------- import / export
  function exportJSON() { return JSON.stringify(P, null, 2) + "\n"; }
  function openIO(mode) {
    const io = $("#io"), ta = $("#io-text");
    io.hidden = false; io.dataset.mode = mode;
    $("#io-title").textContent = mode === "export" ? "params.json" : "Load a params.json";
    $("#io-hint").textContent = mode === "export"
      ? "Replace params.json in the repo with this, then run render.py / score.py — they'll match what you see here."
      : "Paste a params.json here, or pick a file.";
    ta.value = mode === "export" ? exportJSON() : "";
    $("#io-apply").hidden = mode === "export"; $("#io-file").hidden = mode === "export"; $("#io-copy").hidden = mode !== "export";
    ta.focus(); if (mode === "export") ta.select();
  }
  function applyImport(text) {
    try {
      const next = JSON.parse(text);
      if (!next.lattice || !next.growth) throw new Error("That doesn't look like this project's params.json.");
      P = next; buildPanel(); rebuild(); saveDraft(); $("#io").hidden = true;
    } catch (e) { $("#io-hint").textContent = "Couldn't load that: " + e.message; }
  }

  // ---------------------------------------------------------------- boot
  function boot() {
    try { buildPanel(); }
    catch (e) {
      // never leave the page stuck on "Starting…": fall back to the repo's settings
      P = clone(DEFAULTS); restored = false;
      try { localStorage.removeItem(STORE); } catch (e2) { /* ignore */ }
      buildPanel();
      showError("Your saved settings couldn't be loaded, so this is the repo's version. (" + e.message + ")");
    }
    if (restored && JSON.stringify(P) !== JSON.stringify(DEFAULTS)) {
      $("#restored").hidden = false;
    }
    try { renderer = new DomeRenderer(canvas); renderer.onTexture = () => { dirty = true; }; }
    catch (e) { showError(e.message); }
    rebuild();
    // a moment worth opening on: the first comet mid-flight
    const T0 = (P.tangents || [])[0];
    ui.t = T0 ? T0.launch_s + T0.flight_s * 0.62 : 40;

    $("#play").addEventListener("click", () => setPlaying(!ui.playing));
    ui.scrub.addEventListener("input", () => { ui.t = Number(ui.scrub.value); dirty = true; });
    $("#back").addEventListener("click", () => seek(ui.t - 5));
    $("#fwd").addEventListener("click", () => seek(ui.t + 5));
    $("#speed").addEventListener("change", (e) => { ui.speed = Number(e.target.value); });
    $("#res").addEventListener("change", (e) => { ui.res = Number(e.target.value); dirty = true; });
    $("#ssq").addEventListener("change", (e) => { ui.ss = Number(e.target.value); dirty = true; });
    document.querySelectorAll("[name=proj]").forEach((r) => r.addEventListener("change", (e) => {
      ui.proj = Number(e.target.value); $("#stage").dataset.proj = ui.proj; dirty = true; drawOverlay();
    }));
    $("#guides").addEventListener("change", (e) => { ui.guides = e.target.checked; drawOverlay(); });
    $("#loop").addEventListener("change", (e) => { ui.loop = e.target.checked; });
    $("#helpt").addEventListener("change", (e) => { document.body.classList.toggle("showhelp", e.target.checked); });
    $("#export").addEventListener("click", () => openIO("export"));
    $("#import").addEventListener("click", () => openIO("import"));
    $("#io-close").addEventListener("click", () => { $("#io").hidden = true; });
    $("#io-copy").addEventListener("click", (ev) => {
      const ta = $("#io-text"), b = ev.currentTarget;
      navigator.clipboard.writeText(ta.value).then(() => { b.textContent = "Copied"; setTimeout(() => { b.textContent = "Copy"; }, 1500); })
        .catch(() => { ta.focus(); ta.select(); $("#io-hint").textContent = "Your browser blocked copying — the text is selected, so press Ctrl/⌘ C."; });
    });
    $("#io-apply").addEventListener("click", () => applyImport($("#io-text").value));
    $("#io-file").addEventListener("change", (e) => {
      const f = e.target.files[0]; if (!f) return;
      const r = new FileReader(); r.onload = () => applyImport(String(r.result)); r.readAsText(f);
    });
    $("#resetall").addEventListener("click", (ev) => {
      const b = ev.currentTarget;
      if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = "Click again to reset everything"; setTimeout(() => { b.dataset.armed = ""; b.textContent = "Reset all"; }, 3000); return; }
      b.dataset.armed = ""; b.textContent = "Reset all";
      P = clone(DEFAULTS); buildPanel(); rebuild(); saveDraft(); $("#restored").hidden = true;
    });
    $("#restored-reset").addEventListener("click", () => { P = clone(DEFAULTS); buildPanel(); rebuild(); saveDraft(); $("#restored").hidden = true; });
    $("#restored-close").addEventListener("click", () => { $("#restored").hidden = true; });
    $("#dice").addEventListener("click", () => { P.seed = 1 + Math.floor(Math.random() * 9999); refreshAll(); changed("seed"); });
    document.addEventListener("keydown", (e) => {
      if (e.target.closest("input, textarea, select")) return;
      if (e.code === "Space") { e.preventDefault(); setPlaying(!ui.playing); }
      if (e.key === "ArrowLeft") seek(ui.t - (e.shiftKey ? 5 : 1 / 30));
      if (e.key === "ArrowRight") seek(ui.t + (e.shiftKey ? 5 : 1 / 30));
    });
    new ResizeObserver(drawOverlay).observe(canvas);
    requestAnimationFrame(frame);
  }
  boot();
})();
