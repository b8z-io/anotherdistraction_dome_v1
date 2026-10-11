#!/usr/bin/env python3
"""Another Distraction — headless renderer.

Every frame is a pure function of (time, params.json), so any frame can be
rendered on its own, at any resolution, on any machine, and come out the same.

Examples
  python render.py --times 0 5 15 30 45 --sheet sheet.png        # contact sheet
  python render.py --range 0 45 --res 1024 --out frames/seed       # sequence
  python render.py --range 0 45 --res 4096 --ss 2 --out frames/4k  # final-ish
  python render.py --times 30 --proj equirect --res 2048           # VR preview
  python render.py --range 176 289 --proj reel --res 1280 --out frames/reel   # 9:16 phone cut (720x1280)
  python render.py --range 0 45 --res 512 --out frames/seed --movie   # frames + seed.mp4
  python render.py --range 0 289 --res 4096 --ss 2 --fps 60 --audio score/mix_stereo.wav \
                   --stream another_distraction_4k60.mp4                # 4K60 HEVC, no PNGs
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


def o_fov(P):
    return P["output"]["fov_deg"]


class Renderer:
    def __init__(self, P, res, proj, ss, params_path):
        self.P = P
        self.TL = tl.load(str(Path(params_path).resolve()))
        G = self.TL.G
        self.proj = proj
        reel = P.get("reel", {})
        self.w = res * 2 if proj == "equirect" else (int(round(res * 9 / 16 / 2)) * 2 if proj == "reel" else res)
        self.h = res
        # the angle one output pixel covers vertically (sets the text mip level)
        self.vfov = reel.get("vfov_deg", 120) if proj == "reel" else o_fov(P)
        self.text_scale = reel.get("text_scale", 1.0) if proj == "reel" else 1.0
        self.ss = ss
        # Linux servers: headless EGL. Mac (CGL) / Windows (WGL): the default context.
        if sys.platform.startswith("linux"):
            self.ctx = moderngl.create_standalone_context(backend="egl")
        else:
            self.ctx = moderngl.create_standalone_context(require=330)
        frag = (ROOT / "shaders" / "lattice.frag").read_text()
        vert = """#version 330
        in vec2 in_pos; void main(){ gl_Position = vec4(in_pos,0,1); }"""
        self.prog = self.ctx.program(vertex_shader=vert, fragment_shader=frag)
        self.post = self.ctx.program(vertex_shader=vert, fragment_shader=(ROOT / "shaders" / "post.frag").read_text())
        quad = self.ctx.buffer(np.array([-1, -1, 1, -1, -1, 1, 1, 1], dtype="f4"))
        self.vao = self.ctx.vertex_array(self.prog, [(quad, "2f", "in_pos")])
        self.vao_post = self.ctx.vertex_array(self.post, [(quad, "2f", "in_pos")])
        # pass 1 -> linear HDR colour + depth (float, mipmapped for the blur); pass 2 -> 8-bit picture
        self.hdr = self.ctx.texture((self.w, self.h), 4, dtype="f4")
        self.hdr.repeat_x = self.hdr.repeat_y = False
        self.fbo_hdr = self.ctx.framebuffer(color_attachments=[self.hdr])
        self.fbo = self.ctx.simple_framebuffer((self.w, self.h), components=4)
        # blur sizes are given in degrees of the dome: convert to output pixels
        self.px_per_deg = self.h / (180.0 if proj == "equirect" else self.vfov)

        n = G["N"]
        def tex3d(arr, unit):
            t = self.ctx.texture3d((n, n, n), 4, arr.tobytes(), dtype="f4")
            t.filter = (moderngl.NEAREST, moderngl.NEAREST)
            t.use(unit)
            return t
        self.textures = [tex3d(G["tex"], 0)]
        self.textures += [tex3d(pt, 1 + k) for k, pt in enumerate(self.TL.paint_tex)]
        # the credo's typeset texture (tools/make_quote.py)
        qimg = Image.open(ROOT / "assets" / "text" / "quote.png").convert("RGBA")
        self.qmeta = json.loads((ROOT / "assets" / "text" / "quote.json").read_text())
        qt = self.ctx.texture(qimg.size, 4, qimg.tobytes())
        qt.build_mipmaps()
        qt.filter = (moderngl.LINEAR_MIPMAP_LINEAR, moderngl.LINEAR)
        qt.use(9)
        self.textures.append(qt)

        o, L, S, look, R, C = P["output"], P["lattice"], P["seed_point"], P["look"], P["render"], P["camera"]
        PT = P["paint"]
        pad8 = lambda xs, fill=0.0: list(xs) + [fill] * (8 - len(xs))
        Tn = self.TL.tangents
        cols = [(*T["color"], T["launch_s"]) for T in Tn] + [(0.0, 0.0, 0.0, 1e9)] * (16 - len(Tn))
        self.spA = [(T["land_s"], math.radians(T["hue_spread_deg"]), T["hue_time_s"]) for T in Tn]
        sh = P.get("show", {})
        static = {
            "uRes": (self.w, self.h),
            "uProj": {"equirect": 1, "reel": 2}.get(proj, 0),
            "uFov": reel.get("vfov_deg", 120) if proj == "reel" else o["fov_deg"],
            "uTilt": reel.get("pitch_deg", 52) if proj == "reel" else o["tilt_deg"], "uSS": ss,
            "uSeed": float(P["seed"]),
            "uVoidIn": C["void_inner"], "uVoidOut": C["void_outer"],
            "uLatRot": mat(G["rot"]),
            "uCell": L["cell"], "uStrutR": L["strut_radius"], "uNodeR": L["node_radius"],
            "uGraph": 0, **{f"uPaint{k}": 1 + k for k in range(8)},
            "uGridH": G["H"], "uExtent": L["extent"], "uXDelay": L["crosslink_delay"],
            "uSeedPos": tuple(G["stats"]["root_world"]), "uStarSize": S["star_size_rad"],
            "uNumT": len(Tn), "uSpCol": cols,
            "uFocusIdx": int(sh.get("focus_tangent", -1)),
            "uText": 9, "uTextSize": tuple(self.qmeta["size"]),
            "uNovaT": P.get("nova", {}).get("t", 1e9), "uNovaHue": P.get("nova", {}).get("hue_per_path", 0.0),
            "uNovaLevel": P.get("nova", {}).get("level", 0.6),
            "uSoftT": PT["fade_in_s"], "uPulseT": PT["pulse_s"], "uTintAmt": PT["tint_amount"],
            "uHueJitter": math.radians(PT["hue_jitter_deg"]), "uVivid": PT["vivid"],
            "uColDeep": tuple(look["col_deep"]), "uColStrut": tuple(look["col_strut"]),
            "uColTip": tuple(look["col_tip"]), "uGlow": look["glow"], "uGlowW": look["glow_width"],
            "uTipGlow": look["tip_glow"], "uFogDist": look["fog_distance"], "uExposure": look["exposure"],
            "uSteps": R["steps"], "uFar": R["far"],
        }
        for k, v in static.items():
            if k in self.prog:
                self.prog[k].value = v

    def uniforms(self, t):
        TL, P = self.TL, self.P
        cam, R = TL.camera(t)
        u = {"uFront": TL.front(t), "uStar": TL.star(t),
             "uCamPos": tuple(cam), "uCamRot": mat(R)}
        u["uTime"] = t
        u["uSpA"] = [(*a, TL.pulse(T, t)) for a, T in zip(self.spA, TL.tangents)] + [(0.0, 0.0, 1.0, 0.0)] * (16 - len(TL.tangents))
        u["uSpB"] = [(*T.get("fade_s", [0.0, 0.0]), 0.0, 0.0) for T in TL.tangents] + [(0.0, 0.0, 0.0, 0.0)] * (16 - len(TL.tangents))
        u["uMaster"] = TL.master(t)
        u["uLatLevel"] = TL.lattice_level(t)
        u["uShell"] = (*TL.shell(t), 0.0)
        Q = P.get("quote")
        card, ca, cr = TL.quote(t)
        if Q and card >= 0:
            rad = math.radians(Q["deg_per_px"] * self.text_scale)
            rect, crect = self.qmeta["cards"][card], self.qmeta["credit"]
            az, el = Q["dir"]
            drop = math.degrees((rect[3] / 2 + crect[3] / 2) * rad) + Q["credit_gap_deg"] * self.text_scale
            screen = math.radians(self.vfov) / self.h / max(self.ss, 1)
            u.update({"uTextRect": tuple(rect), "uCreditRect": tuple(crect),
                      "uTextDir": tuple(tl.dir_from(az, el)), "uCreditDir": tuple(tl.dir_from(az, el - drop)),
                      "uTextAlpha": (ca, cr), "uTextRad": rad, "uTextLod": max(0.0, math.log2(screen / rad)),
                      "uTextCol": tuple(c * Q["level"] for c in Q["color"]), "uTextHalo": Q["halo"]})
        else:
            u["uTextAlpha"] = (0.0, 0.0)
        u["uFocus"] = TL.focus(t)
        rib = np.zeros((4 * 24, 4), np.float32)
        ribcol = [(0.0, 0.0, 0.0, 0.0)] * 4
        flash = [(0.0, 0.0, 0.0, 0.0)] * 8
        flashcol = [(0.0, 0.0, 0.0, 1.0)] * 8
        slot = fslot = 0
        for T in TL.tangents:
            r = TL.ribbon(T, t)
            if r is not None and slot < 4:
                rib[slot * 24:(slot + 1) * 24, :3] = r[0]
                rib[slot * 24:(slot + 1) * 24, 3] = r[1]
                ribcol[slot] = (*T["color"], T["width"])
                slot += 1
                if t < T["land_s"] and fslot < 8:      # the comet's glowing head
                    flash[fslot] = (*r[0][-1], T["head_glow"])
                    flashcol[fslot] = (*T["color"], T["head_size"])
                    fslot += 1
            f = TL.flash(T, t)
            if f > 0.01 and fslot < 8:
                flash[fslot] = (*T["land"], f)
                flashcol[fslot] = (*T["color"], T["flash_size"])
                fslot += 1
        m = TL.meteor(t)
        if m is not None and slot < 4:
            M = P["meteor"]
            rib[slot * 24:(slot + 1) * 24, :3] = m[0]
            rib[slot * 24:(slot + 1) * 24, 3] = m[1]
            ribcol[slot] = (*M["color"], M["width"])
            slot += 1
            if fslot < 8:
                flash[fslot] = (*m[0][-1], M["head_glow"] * m[1][-1] / max(M["intensity"], 1e-6))
                flashcol[fslot] = (*M["color"], M["head_size"])
                fslot += 1
        u.update({"uNumRib": slot, "uRib": [tuple(x) for x in rib], "uRibCol": ribcol,
                  "uFlash": flash, "uFlashCol": flashcol})
        return u

    def frame(self, t):
        u = self.uniforms(t)
        D = self.P.get("dof", {})
        fpos, strength = self.TL.dof(t)
        u["uFocusPos"] = tuple(float(x) for x in fpos)
        r0 = D.get("focus_radius", 6.0)
        u["uFocusR"] = (r0, r0 + max(D.get("falloff", 16.0), 1e-3))      # sharp inside, fully soft beyond
        u["uDirect"] = 0
        for k, v in u.items():
            if k in self.prog:
                self.prog[k].value = v
        self.fbo_hdr.use()
        self.vao.render(moderngl.TRIANGLE_STRIP)
        coc_max = D.get("max_deg", 0.0) * strength * self.px_per_deg
        if coc_max > 0:                       # mip levels let wide blurs gather smoothly with few taps
            self.hdr.build_mipmaps()
            self.hdr.filter = (moderngl.LINEAR_MIPMAP_LINEAR, moderngl.LINEAR)
        else:                                 # (a mipmap filter without fresh levels reads as black)
            self.hdr.filter = (moderngl.LINEAR, moderngl.LINEAR)
        self.hdr.use(10)
        post = {"uSrc": 10, "uRes": (self.w, self.h), "uCocMax": coc_max, "uTaps": int(D.get("taps", 64)), "uDim": D.get("dim", 0.0) * strength,
                "uMaskCircle": 1 if self.proj == "domemaster" else 0,
                "uExposure": self.P["look"]["exposure"], "uMaster": u["uMaster"], "uSeed": float(self.P["seed"])}
        for k, v in post.items():
            if k in self.post:
                self.post[k].value = v
        self.fbo.use()
        self.vao_post.render(moderngl.TRIANGLE_STRIP)
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


def stream_movie(r, times, out, fps, codec, audio):
    """Render straight into ffmpeg's stdin: nothing touches the disk but the movie."""
    import subprocess
    from movie import ffmpeg_exe, CODECS
    ext, args = CODECS[codec]
    cmd = [ffmpeg_exe(), "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
           "-s", f"{r.w}x{r.h}", "-framerate", str(fps), "-i", "-"]
    if audio:
        cmd += ["-ss", f"{times[0]:.6f}", "-i", str(audio), "-map", "0:v", "-map", "1:a", "-shortest"]
        cmd += ["-c:a", "pcm_s24le"] if codec == "prores" else ["-c:a", "aac", "-b:a", "320k"]
    if ext == ".mp4":
        args = args + ["-movflags", "+faststart"]
    ff = subprocess.Popen(cmd + args + [str(out)], stdin=subprocess.PIPE)
    t0 = time.time()
    for i, t in enumerate(times):
        ff.stdin.write(r.frame(t).tobytes())
        done = i + 1
        eta = (time.time() - t0) / done * (len(times) - done)
        print(f"t={t:7.2f}s  frame {done}/{len(times)}  {time.time() - t0:7.0f}s elapsed  ~{eta / 60:5.0f} min left", flush=True)
    ff.stdin.close()
    if ff.wait():
        sys.exit("ffmpeg failed")
    print(f"{out}  ({len(times)} frames at {fps:g}fps, {codec})")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--params", default=str(ROOT / "params.json"))
    ap.add_argument("--times", type=float, nargs="*")
    ap.add_argument("--range", type=float, nargs=2, metavar=("START", "END"))
    ap.add_argument("--res", type=int)
    ap.add_argument("--ss", type=int)
    ap.add_argument("--proj", choices=["domemaster", "equirect", "reel"],
                    help="reel = 9:16 phone view looking up at the dome (--res sets the height)")
    ap.add_argument("--out", default="frames")
    ap.add_argument("--sheet")
    ap.add_argument("--cols", type=int, default=4)
    ap.add_argument("--movie", nargs="?", const="h264", choices=["h264", "hevc", "prores"],
                    help="after a --range render, stitch the frames into a movie (default h264)")
    ap.add_argument("--audio", help="with --movie/--stream: soundtrack to lay in (e.g. score/mix_stereo.wav)")
    ap.add_argument("--fps", type=float, help="override output.fps (e.g. 60)")
    ap.add_argument("--stream", metavar="MOVIE",
                    help="with --range: pipe frames straight into this movie file, no PNGs on disk "
                         "(codec from --movie, default hevc). For 4K+: a PNG per frame is ~15 MB.")
    a = ap.parse_args()

    P = json.loads(Path(a.params).read_text())
    if a.fps:
        P["output"]["fps"] = a.fps
    res = a.res or P["output"]["preview_res"]
    ss = a.ss or P["output"]["supersample"]
    proj = a.proj or P["output"]["projection"]
    r = Renderer(P, res, proj, ss, a.params)

    if a.range:
        fps = P["output"]["fps"]
        times = [a.range[0] + i / fps for i in range(int(round((a.range[1] - a.range[0]) * fps)) + 1)]
    else:
        times = a.times or [0.0]

    if a.stream:
        stream_movie(r, times, a.stream, P["output"]["fps"], a.movie or "hevc", a.audio)
        return

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
        make_movie(a.out, codec=a.movie, fps=P["output"]["fps"], audio=a.audio)


if __name__ == "__main__":
    main()
