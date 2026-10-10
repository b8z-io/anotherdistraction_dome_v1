#!/usr/bin/env python3
"""Another Distraction — the procedural score.

Generated from the same timeline as the picture (timeline.py), so every sound
lands on the frame it belongs to and comes from where it happens on the dome.

  * drone    — the lattice: a low D drone whose upper partials open as it grows,
               with a faint high tone for the seed star
  * pings    — every node that switches on rings a soft tuned bell (D pentatonic),
               pitched by height, panned to where it is: growth you can hear
  * tangents — each tangent's motif starts *before* it appears, from where it will
               emerge (ears get distracted first), then follows the ribbon round the
               dome with a whoosh tied to its speed; a chord blooms where it lands
               and a warm pad holds while its colour stays in the lattice
  * paint    — every strut a tangent paints chimes in that tangent's chord as the
               colour reaches it: the harmony changes as the colour spreads
  * reverb   — one shared space

Outputs (in --out, default score/):
  mix_stereo.wav           stereo mix (24-bit, 48 kHz)
  mix_ambix.wav            first-order ambisonics, AmbiX (ACN/SN3D: W Y Z X) for dome speaker arrays
  stem_<name>.wav          stereo stems (drone, pings, paint, tangents, reverb) — they sum to the mix

  python score.py --end 90
"""
import argparse, json, math, wave
from pathlib import Path

import numpy as np

import timeline as tl

ROOT = Path(__file__).resolve().parent
SR = 48000
NOTE = {"C": -9, "C#": -8, "Db": -8, "D": -7, "D#": -6, "Eb": -6, "E": -5, "F": -4,
        "F#": -3, "Gb": -3, "G": -2, "G#": -1, "Ab": -1, "A": 0, "A#": 1, "Bb": 1, "B": 2}


def hz(name):
    """'F#4' -> Hz (A4 = 440)."""
    n, o = name[:-1], int(name[-1])
    return 440.0 * 2 ** ((NOTE[n] + 12 * (o - 4)) / 12)


def smoothstep(x):
    x = np.clip(x, 0, 1)
    return x * x * (3 - 2 * x)


class Mixer:
    """Stereo stems + one first-order ambisonic bus. Sources are placed by their
    direction in the *camera* frame (x right, y up, -z front)."""

    def __init__(self, n, stems):
        self.n = n
        self.st = {s: np.zeros((2, n)) for s in stems}
        self.amb = np.zeros((4, n))

    @staticmethod
    def gains(d):
        d = np.asarray(d, float)
        d = d / np.maximum(np.linalg.norm(d, axis=-1, keepdims=True), 1e-9)
        x, y, z = d[..., 0], d[..., 1], d[..., 2]
        pan = np.clip(x / np.maximum(np.sqrt(x * x + z * z), 1e-6), -1, 1)   # left/right only, in stereo
        th = (pan + 1) * math.pi / 4
        st = np.stack([np.cos(th), np.sin(th)])
        # AmbiX: forward = -z, left = -x, up = y
        amb = np.stack([np.ones_like(x), -x, y, -z])
        return st, amb

    def add(self, sig, start, d, stem, width=0.0):
        """sig: mono samples; d: one direction (3,) or one per sample (len, 3)."""
        i0 = max(start, 0)
        i1 = min(start + len(sig), self.n)
        if i1 <= i0:
            return
        sig = sig[i0 - start:i1 - start]
        d = np.asarray(d, float)
        if d.ndim == 2:
            d = d[i0 - start:i1 - start]
        st, amb = self.gains(d)
        if d.ndim == 1:
            st, amb = st[:, None], amb[:, None]
        if width:   # spread toward the centre for big, diffuse sounds
            st = st * (1 - width) + width * math.sqrt(0.5)
        self.st[stem][:, i0:i1] += st * sig
        self.amb[:, i0:i1] += amb * sig


def bell(f, tau, n):
    t = np.arange(n) / SR
    env = np.minimum(t / 0.004, 1.0)
    return env * (np.sin(2 * np.pi * f * t) * np.exp(-t / tau)
                  + 0.28 * np.sin(2 * np.pi * 2.76 * f * t) * np.exp(-t / (tau / 3))
                  + 0.10 * np.sin(2 * np.pi * 5.40 * f * t) * np.exp(-t / (tau / 6)))


def fm_voice(freq, amp, idx=1.3, ratio=2.0):
    """freq, amp: per-sample arrays. Warm FM voice."""
    ph_c = 2 * np.pi * np.cumsum(freq) / SR
    ph_m = 2 * np.pi * np.cumsum(freq * ratio) / SR
    return amp * np.sin(ph_c + idx * amp / max(amp.max(), 1e-9) * np.sin(ph_m))


def additive(f, n, partials=6, detune=0.0025, seed=0, tilt=1.0):
    rng = np.random.default_rng(seed)
    t = np.arange(n) / SR
    out = np.zeros(n)
    for k in range(1, partials + 1):
        for s in (-1, 1):
            ff = f * k * (1 + s * detune * rng.uniform(0.5, 1.0))
            lfo = 1 + 0.25 * np.sin(2 * np.pi * rng.uniform(0.05, 0.2) * t + rng.uniform(0, 6.28))
            out += np.sin(2 * np.pi * ff * t + rng.uniform(0, 6.28)) * lfo / k ** tilt
    return out / (2 * partials)


def bandpass_noise(n, fc, q_oct, seed):
    """White noise through a time-varying band-pass (fc per sample), via overlap-add FFT."""
    rng = np.random.default_rng(seed)
    x = rng.standard_normal(n + 4096)
    B, hop = 2048, 1024
    win = np.hanning(B)
    out = np.zeros(n + 4096)
    freqs = np.fft.rfftfreq(B, 1 / SR)
    lf = np.log2(np.maximum(freqs, 1.0))
    for s in range(0, n, hop):
        c = fc[min(s + B // 2, n - 1)]
        mask = np.exp(-0.5 * ((lf - math.log2(max(c, 20))) / q_oct) ** 2)
        out[s:s + B] += np.fft.irfft(np.fft.rfft(x[s:s + B] * win) * mask, B) * win
    return out[:n] / 1.5


def reverb_ir(seconds, seed, rt60=3.2):
    rng = np.random.default_rng(seed)
    n = int(seconds * SR)
    t = np.arange(n) / SR
    ir = rng.standard_normal(n) * np.exp(-6.91 * t / rt60)
    # darken the tail: one-pole low-pass whose cutoff falls over time
    a = np.exp(-2 * np.pi * np.linspace(6000, 1200, n) / SR)
    y = np.zeros(n)
    acc = 0.0
    for i in range(0, n, 256):           # blockwise is plenty for a fixed IR
        seg = ir[i:i + 256]
        out = np.empty_like(seg)
        ai = a[i]
        for j, v in enumerate(seg):
            acc = ai * acc + (1 - ai) * v
            out[j] = acc
        y[i:i + 256] = out
    y[: int(0.02 * SR)] = 0               # pre-delay
    return y / np.sqrt(np.sum(y ** 2))


def convolve(x, ir):
    n = len(x) + len(ir) - 1
    N = 1 << (n - 1).bit_length()
    return np.fft.irfft(np.fft.rfft(x, N) * np.fft.rfft(ir, N), N)[: len(x)]


def write_wav(path, data):
    """data: (channels, n) floats in [-1, 1] -> 24-bit PCM."""
    d = np.clip(data, -1, 1)
    i = np.ascontiguousarray((d.T * (2 ** 23 - 1)).astype("<i4"))
    b = i.view(np.uint8).reshape(-1, 4)[:, :3].tobytes()
    with wave.open(str(path), "wb") as w:
        w.setnchannels(data.shape[0])
        w.setsampwidth(3)
        w.setframerate(SR)
        w.writeframes(b)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--params", default=str(ROOT / "params.json"))
    ap.add_argument("--end", type=float, help="seconds (default: last event + 10s)")
    ap.add_argument("--out", default=str(ROOT / "score"))
    a = ap.parse_args()

    P = json.loads(Path(a.params).read_text())
    S = P["score"]
    TL = tl.load(str(Path(a.params).resolve()))
    G = TL.G
    end = a.end or max([T["land_s"] + 10 for T in TL.tangents] + [P["growth"]["front_keys"][-1][0] + 5])
    n = int(end * SR)
    M = Mixer(n, ["drone", "pings", "paint", "tangents", "reverb"])
    t_ctl = np.arange(0, end + 0.01, 0.01)                  # 100 Hz control rate
    t_smp = np.arange(n) / SR

    def to_cam(world_pts, times):
        """World points at the given times -> camera-frame directions."""
        out = []
        for p, t in zip(np.atleast_2d(world_pts), np.atleast_1d(times)):
            cam, R = TL.camera(t)
            out.append(R.T @ (p - cam))
        return np.array(out)

    # ---------------------------------------------------------------- node reveal times
    fr = np.array([TL.front(t) for t in t_ctl])
    fr_mono = np.maximum.accumulate(np.maximum(fr, -1))
    nd = G["node_dist"]
    first = np.searchsorted(fr_mono, nd)                     # first control step past each node
    revealed = first < len(t_ctl)
    t_rev = np.where(revealed, t_ctl[np.minimum(first, len(t_ctl) - 1)], np.inf)
    count = np.array([(t_rev <= t).sum() for t in t_ctl])
    growth = count / max(count[-1], 1)

    # ---------------------------------------------------------------- drone
    D = S["drone"]
    env = np.interp(t_smp, t_ctl, np.array([TL.star(t) for t in t_ctl]) / P["seed_point"]["star_intensity"])
    bright = np.interp(t_smp, t_ctl, growth)
    rng = np.random.default_rng(P["seed"])
    drone = np.zeros(n)
    for base in (hz(x) for x in D["notes"]):
        for k in range(1, 9):
            gate = smoothstep(bright * 7 - k + 3) if k > 2 else 1.0
            for s, w in ((-1, 1.0), (1, 0.55)):     # unequal pair: slow beating, never a full null
                f = base * k * (1 + s * 0.0011 * rng.uniform(0.6, 1.4))
                lfo = 1 + 0.2 * np.sin(2 * np.pi * rng.uniform(0.03, 0.11) * t_smp + rng.uniform(0, 6.28))
                drone += np.sin(2 * np.pi * f * t_smp + rng.uniform(0, 6.28)) * w * lfo * gate / k ** 1.3
    drone *= D["level"] * env * (0.7 + 0.3 * bright)
    M.add(drone, 0, [0, 1, 0], "drone", width=0.6)
    f_star = hz(D["star_note"]) * (1 + 0.002 * np.sin(2 * np.pi * 0.23 * t_smp))
    star_tone = np.sin(2 * np.pi * np.cumsum(f_star) / SR)
    star_tone *= D["star_level"] * env * (1 - 0.6 * bright)
    M.add(star_tone, 0, to_cam(np.array(G["stats"]["root_world"]), 0.0)[0], "drone")

    # ---------------------------------------------------------------- pings
    Pi = S["pings"]
    scale = [hz(f"{nm}{o}") for o in (5, 6) for nm in ("D", "E", "F#", "A", "B")] + [hz("D7")]
    taus = (0.35, 0.6, 0.9)
    grains = {(i, j): bell(f, tau, int(tau * 5 * SR)) for i, f in enumerate(scale) for j, tau in enumerate(taus)}
    ids = np.flatnonzero(revealed & (t_rev > 0))
    hist, edges = np.histogram(t_rev[ids], bins=np.arange(0, end + 1, 1.0))
    rng = np.random.default_rng([P["seed"], 7])
    for i in ids:
        t = t_rev[i]
        rel = to_cam(G["node_world"][i], t)[0]
        r = np.linalg.norm(rel)
        if r < 1e-3:
            continue
        elev = rel[1] / r
        rate = hist[min(int(t), len(hist) - 1)]
        amp = Pi["level"] / (1 + r / 7) / math.sqrt(max(rate, 4) / 4) * (1.0 if elev > 0 else 0.35)
        note = int(np.clip((elev + 1) / 2 * (len(scale) - 1) + rng.integers(-1, 2), 0, len(scale) - 1))
        g = grains[(note, int(rng.integers(0, 3)))]
        M.add(g * amp, int(t * SR), rel, "pings")

    # ---------------------------------------------------------------- tangents
    ir = reverb_ir(5.0, P["seed"])
    for T in TL.tangents:
        TS = T["sound"]
        t0, tland = T["launch_s"] - T["precue_s"], T["land_s"]
        t_end = tland + T["absorb_s"]
        # head position over the flight (control rate), sitting at the source before launch
        tc = np.arange(t0, t_end, 0.01)
        heads = []
        for t in tc:
            rb = TL.ribbon(T, t)
            heads.append(rb[0][-1] if rb is not None else (T["src"] if t < T["launch_s"] else T["land"]))
        heads = np.array(heads)
        rel = to_cam(heads, tc)
        speed = np.r_[0, np.linalg.norm(np.diff(heads, axis=0), axis=1) / 0.01]
        dist = np.linalg.norm(rel, axis=1)
        i0, i1 = int(t0 * SR), int(t_end * SR)
        ts = np.arange(i0, i1) / SR
        rel_s = np.stack([np.interp(ts, tc, rel[:, k]) for k in range(3)], axis=1)
        prox = np.interp(ts, tc, 1 / (1 + dist / 8))

        # motif: fades in from where it'll emerge, steps through its notes over the flight
        notes = [hz(x) for x in TS["motif"]]
        u = np.clip((ts - t0) / (tland - t0), 0, 0.9999)
        idx = (u * len(notes)).astype(int)
        f_target = np.array(notes)[idx]
        glide = np.exp(-1 / (0.06 * SR))          # portamento
        f = np.empty_like(f_target)
        acc = f_target[0]
        for k in range(0, len(f), 512):
            seg = f_target[k:k + 512]
            out = np.empty_like(seg)
            for j, v in enumerate(seg):
                acc = glide * acc + (1 - glide) * v
                out[j] = acc
            f[k:k + 512] = out
        art = 0.75 + 0.25 * np.exp(-((u * len(notes)) % 1.0) * 6)        # soft re-articulation
        amp = smoothstep((ts - t0) / T["precue_s"]) * (1 - smoothstep((ts - tland) / 1.0)) * art
        voice = fm_voice(f, amp) * TS["motif_level"] * (0.5 + 0.5 * prox)
        M.add(voice, i0, rel_s, "tangents")

        # whoosh: band-passed air whose pitch and level ride the ribbon's speed
        sp = np.interp(ts, tc, speed)
        wh = bandpass_noise(len(ts), 250 + 140 * sp, 0.45, seed=[P["seed"], 31, T["index"]])
        wh *= TS["whoosh_level"] * smoothstep(sp / 4) * prox
        M.add(wh, i0, rel_s, "tangents")

        # landing: bloom chord + low thump, at the landing node
        land_rel = to_cam(T["land"], tland)[0]
        nb = int(9 * SR)
        tb = np.arange(nb) / SR
        bloom = sum(additive(hz(x), nb, seed=[P["seed"], 41, T["index"], k], tilt=1.4)
                    for k, x in enumerate(TS["chord"]))
        bloom *= np.minimum(tb / 0.04, 1) * (0.55 + 0.45 * np.exp(-tb / 0.5)) * np.exp(-tb / 3.5)
        M.add(bloom * TS["bloom_level"], int(tland * SR), land_rel, "tangents")
        thump = np.sin(2 * np.pi * (40 + 25 * np.exp(-tb[:SR] / 0.08)) * tb[:SR]) * np.exp(-tb[:SR] / 0.35)
        M.add(thump * TS["thump_level"], int(tland * SR), [0, 0, -1], "tangents", width=1.0)

        # paint chimes: each node rings in this tangent's chord as its colour arrives
        Pt = S["paint"]
        chime = [hz(x) * 2 for x in TS["chord"]] + [hz(x) * 4 for x in TS["chord"][1:3]]
        cg = {(k, j): bell(f, tau, int(tau * 5 * SR)) for k, f in enumerate(chime) for j, tau in enumerate((0.5, 0.9))}
        arr, cov = T["paint_arrival"], T["paint_cover"]
        sel = np.flatnonzero((arr >= 0) & (arr < end) & (cov > 0.35))
        hist_p, _ = np.histogram(arr[sel], bins=np.arange(0, end + 1, 0.5))
        rng_p = np.random.default_rng([P["seed"], 61, T["index"]])
        for i in sel:
            t = arr[i]
            rel = to_cam(G["node_world"][i], t)[0]
            r = np.linalg.norm(rel)
            rate = hist_p[min(int(t * 2), len(hist_p) - 1)] * 2
            amp = Pt["level"] * cov[i] / (1 + r / 7) / math.sqrt(max(rate, 6) / 6)
            g = cg[(int(rng_p.integers(0, len(chime))), int(rng_p.integers(0, 2)))]
            M.add(g * amp, int(t * SR), rel, "paint")

        # colour pad: swells as the colour spreads, then stays as long as the colour does
        i2 = int(tland * SR)
        tp = np.arange(i2, n) / SR
        if len(tp):
            painted = np.sort(arr[(arr >= 0) & (cov > 0.35)])
            fc = np.searchsorted(painted, t_ctl) / max(len(painted), 1)
            frac = np.interp(tp, t_ctl, fc)
            pad = sum(additive(hz(x) / 2, len(tp), seed=[P["seed"], 53, T["index"], k], tilt=1.8)
                      for k, x in enumerate(TS["chord"]))
            pad *= TS["pad_level"] * (0.35 + 0.65 * frac) * smoothstep((tp - tland) / 3)
            # it lives where the colour is, which moves as the audience turns
            tc2 = np.arange(tland, end, 0.05)
            lr = to_cam(np.repeat(T["land"][None], len(tc2), 0), tc2)
            lr_s = np.stack([np.interp(tp, tc2, lr[:, k]) for k in range(3)], axis=1)
            M.add(pad, i2, lr_s, "tangents", width=0.3)

    # ---------------------------------------------------------------- reverb + master
    dry = sum(M.st[s] * S["reverb_send"][s] for s in ("drone", "pings", "paint", "tangents"))
    ir_r = reverb_ir(5.0, P["seed"] + 1)
    M.st["reverb"] = np.stack([convolve(dry[0], ir), convolve(dry[1], ir_r)]) * S["reverb_level"]
    # ambisonic reverb: decorrelated tails, diffuse
    w_dry = sum(M.st[s].sum(0) * S["reverb_send"][s] for s in ("drone", "pings", "paint", "tangents")) * 0.5
    amb_rev = np.stack([convolve(w_dry, reverb_ir(5.0, P["seed"] + 10 + k)) for k in range(4)])
    amb_rev[1:] *= 0.4
    amb = M.amb + amb_rev * S["reverb_level"]

    mix = sum(M.st.values())
    fade = np.minimum(1, (end - t_smp) / 2.0)       # 2s fade at the end of the render
    peak = max(np.abs(mix).max(), np.abs(amb).max() / 1.5, 1e-9)
    g = 10 ** (S["master_peak_db"] / 20) / peak
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    write_wav(out / "mix_stereo.wav", mix * g * fade)
    write_wav(out / "mix_ambix.wav", amb * g / 1.5 * fade)
    for s, x in M.st.items():
        write_wav(out / f"stem_{s}.wav", x * g * fade)
    print(f"{out}/mix_stereo.wav  ({end:.1f}s, {len(ids)} node pings, {len(TL.tangents)} tangents)")


if __name__ == "__main__":
    main()
