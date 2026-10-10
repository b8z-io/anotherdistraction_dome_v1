#!/usr/bin/env python3
"""Another Distraction — headless renderer.

Every frame is a pure function of (time, params.json), so any frame can be
rendered on its own, at any resolution, on any machine, and come out the same.

Examples
  python render.py --times 0 5 15 30 45 --sheet sheet.png        # contact sheet
  python render.py --range 0 45 --res 1024 --out frames/seed       # sequence
  python render.py --range 0 45 --res 4096 --ss 2 --out frames/4k  # final-ish
  python render.py --times 30 --proj equirect --res 2048           # VR preview
"""
import argparse, json, math, os, time
from pathlib import Path

import numpy as np
import moderngl
from PIL import Image, ImageDraw, ImageFont

import lattice

ROOT = Path(__file__).resolve().parent


def smooth(x):
    x = min(max(x, 0.0), 1.0)
    return x * x * (3 - 2 * x)


def envelope(P, t):
    """Time-dependent values. Kept here so the shader stays a pure function."""
    g = P["growth"]
    u = (t - g["start_s"]) / (g["end_s"] - g["start_s"])
    front = -1.0 if u <= 0 else g["end_path"] * min(u, 1.0) ** g["curve_power"]
    s = P["seed_point"]
    a, b = s["star_fade_in_s"]
    star = s["star_intensity"] * smooth((t - a) / max(b - a, 1e-6))
    return {"uFront": front, "uStar": star}


class Renderer:
    def __init__(self, P, res, proj, ss):
        self.P = P
        self.w = res * 2 if proj == "equirect" else res
        self.h = res
        self.ctx = moderngl.create_standalone_context(backend="egl")
        frag = (ROOT / "shaders" / "lattice.frag").read_text()
        vert = """#version 330
        in vec2 in_pos; void main(){ gl_Position = vec4(in_pos,0,1); }"""
        self.prog = self.ctx.program(vertex_shader=vert, fragment_shader=frag)
        quad = np.array([-1, -1, 1, -1, -1, 1, 1, 1], dtype="f4")
        self.vao = self.ctx.vertex_array(self.prog, [(self.ctx.buffer(quad), "2f", "in_pos")])
        self.fbo = self.ctx.simple_framebuffer((self.w, self.h), components=4)
        o, L, S, look, R = P["output"], P["lattice"], P["seed_point"], P["look"], P["render"]
        tex, H, rot, self.stats = lattice.build(P)
        n = 2 * H + 1
        self.graph = self.ctx.texture3d((n, n, n), 4, tex.tobytes(), dtype="f4")
        self.graph.filter = (moderngl.NEAREST, moderngl.NEAREST)
        self.graph.use(0)
        static = {
            "uRes": (self.w, self.h),
            "uProj": 1 if proj == "equirect" else 0,
            "uFov": o["fov_deg"], "uTilt": o["tilt_deg"], "uSS": ss,
            "uSeed": float(P["seed"]),
            "uLatRot": tuple(rot.T.flatten()),
            "uCell": L["cell"], "uStrutR": L["strut_radius"], "uNodeR": L["node_radius"],
            "uGraph": 0, "uGridH": H, "uExtent": L["extent"], "uXDelay": L["crosslink_delay"],
            "uSeedPos": tuple(self.stats["root_world"]), "uStarSize": S["star_size_rad"],
            "uColDeep": tuple(look["col_deep"]), "uColStrut": tuple(look["col_strut"]),
            "uColTip": tuple(look["col_tip"]), "uGlow": look["glow"], "uGlowW": look["glow_width"],
            "uTipGlow": look["tip_glow"], "uFogDist": look["fog_distance"], "uExposure": look["exposure"],
            "uSteps": R["steps"], "uFar": R["far"],
        }
        for k, v in static.items():
            if k in self.prog:
                self.prog[k].value = v

    def frame(self, t):
        for k, v in {"uTime": t, **envelope(self.P, t)}.items():
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
    a = ap.parse_args()

    P = json.loads(Path(a.params).read_text())
    res = a.res or P["output"]["preview_res"]
    ss = a.ss or P["output"]["supersample"]
    proj = a.proj or P["output"]["projection"]
    r = Renderer(P, res, proj, ss)

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


if __name__ == "__main__":
    main()
