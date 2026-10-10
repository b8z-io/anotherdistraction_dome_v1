#!/usr/bin/env python3
"""Another Distraction — headless renderer.

Every frame is a pure function of (time, params.json), so any frame can be
rendered on its own, at any resolution, on any machine, and come out the same.

Examples
  python render.py --times 0 5 15 30 45 --sheet sheet.png        # contact sheet
  python render.py --range 0 45 --res 1024 --out frames/seed       # sequence
  python render.py --range 0 45 --res 4096 --ss 2 --out frames/4k  # final-ish
  python render.py --times 30 --proj equirect --res 2048           # VR preview
  python render.py --range 0 45 --res 512 --out frames/seed --movie   # frames + seed.mp4
"""
import argparse, json, math, os, sys, time
from pathlib import Path

import numpy as np
import moderngl
from PIL import Image, ImageDraw, ImageFont

import timeline as tl

ROOT = Path(__file__).resolve().parent


def mat(m):
    """numpy 3x3 -> GLSL mat3 (column-major)."""
    return tuple(np.asarray(m, float).T.flatten())


class Renderer:
    def __init__(self, P, res, proj, ss, params_path):
        self.P = P
        self.TL = tl.load(str(Path(params_path).resolve()))
        G = self.TL.G
        self.w = res * 2 if proj == "equirect" else res
        self.h = res
        # Linux servers: headless EGL. Mac (CGL) / Windows (WGL): the default context.
        if sys.platform.startswith("linux"):
            self.ctx = moderngl.create_standalone_context(backend="egl")
        else:
            self.ctx = moderngl.create_standalone_context(require=330)
        frag = (ROOT / "shaders" / "lattice.frag").read_text()
        vert = """#version 330
        in vec2 in_pos; void main(){ gl_Position = vec4(in_pos,0,1); }"""
        self.prog = self.ctx.program(vertex_shader=vert, fragment_shader=frag)
        quad = np.array([-1, -1, 1, -1, -1, 1, 1, 1], dtype="f4")
        self.vao = self.ctx.vertex_array(self.prog, [(self.ctx.buffer(quad), "2f", "in_pos")])
        self.fbo = self.ctx.simple_framebuffer((self.w, self.h), components=4)

        n = G["N"]
        def tex3d(arr, unit):
            t = self.ctx.texture3d((n, n, n), 4, arr.tobytes(), dtype="f4")
            t.filter = (moderngl.NEAREST, moderngl.NEAREST)
            t.use(unit)
            return t
        self.textures = [tex3d(G["tex"], 0)]
        sp = self.TL.spread_tex + [self.TL.spread_tex[0]] * (2 - len(self.TL.spread_tex))
        self.textures += [tex3d(sp[0], 1), tex3d(sp[1], 2)]

        o, L, S, look, R, C = P["output"], P["lattice"], P["seed_point"], P["look"], P["render"], P["camera"]
        Tn = self.TL.tangents
        cols = [tuple(T["color"]) for T in Tn] + [(0.0, 0.0, 0.0)] * (8 - len(Tn))
        static = {
            "uRes": (self.w, self.h),
            "uProj": 1 if proj == "equirect" else 0,
            "uFov": o["fov_deg"], "uTilt": o["tilt_deg"], "uSS": ss,
            "uSeed": float(P["seed"]),
            "uVoidIn": C["void_inner"], "uVoidOut": C["void_outer"],
            "uLatRot": mat(G["rot"]),
            "uCell": L["cell"], "uStrutR": L["strut_radius"], "uNodeR": L["node_radius"],
            "uGraph": 0, "uSpread0": 1, "uSpread1": 2,
            "uGridH": G["H"], "uExtent": L["extent"], "uXDelay": L["crosslink_delay"],
            "uSeedPos": tuple(G["stats"]["root_world"]), "uStarSize": S["star_size_rad"],
            "uNumT": len(Tn), "uSpCol": cols,
            "uSpLimit": [T["spread_limit"] for T in Tn] + [1.0] * (8 - len(Tn)),
            "uSpSoft": look["spread_soft"], "uPulseW": look["pulse_width"], "uTintAmt": look["tint_amount"],
            "uColDeep": tuple(look["col_deep"]), "uColStrut": tuple(look["col_strut"]),
            "uColTip": tuple(look["col_tip"]), "uGlow": look["glow"], "uGlowW": look["glow_width"],
            "uTipGlow": look["tip_glow"], "uFogDist": look["fog_distance"], "uExposure": look["exposure"],
            "uSteps": R["steps"], "uFar": R["far"],
        }
        for k, v in static.items():
            if k in self.prog:
                self.prog[k].value = v

    def uniforms(self, t):
        TL = self.TL
        cam, R = TL.camera(t)
        u = {"uFront": TL.front(t), "uStar": TL.star(t),
             "uCamPos": tuple(cam), "uCamRot": mat(R)}
        fronts, pulses = [], []
        for T in TL.tangents:
            F = TL.spread_front(T, t)
            fronts.append(F)
            # wavefront glows while the colour is still travelling
            pulses.append(0.0 if F < 0 else T["pulse"] * (1 - F / T["spread_limit"]) ** 1.5)
        u["uSpFront"] = fronts + [-1.0] * (8 - len(fronts))
        u["uSpPulse"] = pulses + [0.0] * (8 - len(pulses))
        rib = np.zeros((4 * 24, 4), np.float32)
        ribcol = [(0.0, 0.0, 0.0, 0.0)] * 4
        flash = [(0.0, 0.0, 0.0, 0.0)] * 4
        flashcol = [(0.0, 0.0, 0.0)] * 4
        slot = fslot = 0
        for T in TL.tangents:
            r = TL.ribbon(T, t)
            if r is not None and slot < 4:
                rib[slot * 24:(slot + 1) * 24, :3] = r[0]
                rib[slot * 24:(slot + 1) * 24, 3] = r[1]
                ribcol[slot] = (*T["color"], T["width"])
                slot += 1
            f = TL.flash(T, t)
            if f > 0.01 and fslot < 4:
                flash[fslot] = (*T["land"], f)
                flashcol[fslot] = tuple(T["color"])
                fslot += 1
        u.update({"uNumRib": slot, "uRib": [tuple(x) for x in rib], "uRibCol": ribcol,
                  "uFlash": flash, "uFlashCol": flashcol})
        return u

    def frame(self, t):
        for k, v in self.uniforms(t).items():
            if k in self.prog:
                self.prog[k].value = v
        self.fbo.use()
        self.vao.render(moderngl.TRIANGLE_STRIP)
        data = self.fbo.read(components=3)
        return Image.frombytes("RGB", (self.w, self.h), data).transpose(Image.FLIP_TOP_BOTTOM)


def contact_sheet(images, labels, out, cols=4):
    w, h = images[0].size
    pad, lab = 12, 28
    rows = math.ceil(len(images) / cols)
    sheet = Image.new("RGB", (cols * (w + pad) + pad, rows * (h + pad + lab) + pad), (18, 18, 20))
    draw = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.truetype("DejaVuSans.ttf", 18)
    except OSError:
        font = ImageFont.load_default()
    for i, (im, label) in enumerate(zip(images, labels)):
        x = pad + (i % cols) * (w + pad)
        y = pad + (i // cols) * (h + pad + lab)
        sheet.paste(im, (x, y))
        draw.text((x, y + h + 4), label, fill=(200, 200, 205), font=font)
    sheet.save(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--params", default=str(ROOT / "params.json"))
    ap.add_argument("--times", type=float, nargs="*")
    ap.add_argument("--range", type=float, nargs=2, metavar=("START", "END"))
    ap.add_argument("--res", type=int)
    ap.add_argument("--ss", type=int)
    ap.add_argument("--proj", choices=["domemaster", "equirect"])
    ap.add_argument("--out", default="frames")
    ap.add_argument("--sheet")
    ap.add_argument("--cols", type=int, default=4)
    ap.add_argument("--movie", nargs="?", const="h264", choices=["h264", "hevc", "prores"],
                    help="after a --range render, stitch the frames into a movie (default h264)")
    a = ap.parse_args()

    P = json.loads(Path(a.params).read_text())
    res = a.res or P["output"]["preview_res"]
    ss = a.ss or P["output"]["supersample"]
    proj = a.proj or P["output"]["projection"]
    r = Renderer(P, res, proj, ss, a.params)

    if a.range:
        fps = P["output"]["fps"]
        times = [a.range[0] + i / fps for i in range(int(round((a.range[1] - a.range[0]) * fps)) + 1)]
    else:
        times = a.times or [0.0]

    imgs = []
    os.makedirs(a.out, exist_ok=True)
    t0 = time.time()
    for i, t in enumerate(times):
        im = r.frame(t)
        if a.sheet:
            imgs.append(im)
        else:
            frame_no = int(round(t * P["output"]["fps"]))
            im.save(Path(a.out) / f"frame_{frame_no:05d}.png")
        print(f"t={t:6.2f}s  {time.time() - t0:6.1f}s elapsed", flush=True)
    if a.sheet:
        contact_sheet(imgs, [f"{t:.1f}s" for t in times], a.sheet, a.cols)
    elif a.movie:
        from movie import make_movie
        make_movie(a.out, codec=a.movie, fps=P["output"]["fps"])


if __name__ == "__main__":
    main()
