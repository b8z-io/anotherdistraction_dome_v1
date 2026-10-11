#!/usr/bin/env python3
"""Decode the first-order AmbiX mix to binaural stereo for headphones.

  python tools/binaural.py                       # score/mix_ambix.wav -> score/mix_binaural.wav

Decodes to 13 virtual speakers around and above the listener (a dome-ish
layout: 8 at the horizon, 4 at 45°, 1 at the zenith, max-rE weighting), then
places each with a spherical-head model (Brown & Duda 1998): interaural time
difference plus frequency-dependent head shadow. No pinna model, so left/right
and width are convincing but front/back and height cues are weak — for proper
height on headphones, play mix_ambix.wav through a binaural decoder with real
HRTFs (e.g. the free IEM BinauralDecoder plugin in Reaper).
"""
import math
import sys
import wave
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SR = 48000
HEAD_R, C = 0.0875, 343.0


def read24(path):
    with wave.open(str(path)) as w:
        n, ch = w.getnframes(), w.getnchannels()
        assert w.getframerate() == SR and w.getsampwidth() == 3
        b = np.frombuffer(w.readframes(n), np.uint8).reshape(-1, 3)
    x = (b[:, 0].astype(np.int32) | (b[:, 1].astype(np.int32) << 8) | (b[:, 2].astype(np.int32) << 16))
    x = np.where(x >= 1 << 23, x - (1 << 24), x).astype(np.float32) / (2 ** 23)
    return x.reshape(-1, ch).T


def write24(path, data):
    d = np.clip(data, -1, 1)
    i = np.ascontiguousarray((d.T * (2 ** 23 - 1)).astype("<i4"))
    with wave.open(str(path), "wb") as w:
        w.setnchannels(data.shape[0]); w.setsampwidth(3); w.setframerate(SR)
        w.writeframes(i.view(np.uint8).reshape(-1, 4)[:, :3].tobytes())


def speakers():
    out = [(az, 0.0) for az in range(0, 360, 45)] + [(az, 45.0) for az in (45, 135, 225, 315)] + [(0.0, 90.0)]
    dirs = []
    for az, el in out:
        a, e = math.radians(az), math.radians(el)
        # AmbiX frame: x forward, y left, z up (azimuth counter-clockwise from front)
        dirs.append((math.cos(a) * math.cos(e), math.sin(a) * math.cos(e), math.sin(e)))
    return np.array(dirs)


def ear_filters(d, n_fft):
    """Spherical-head transfer functions (left, right) for a source in direction d (x fwd, y left, z up)."""
    w = np.fft.rfftfreq(n_fft, 1 / SR) * 2 * np.pi
    w0 = C / HEAD_R
    out = []
    for ear_y in (1.0, -1.0):                      # left ear on +y, right ear on -y
        cos_t = float(np.clip(d[1] * ear_y, -1, 1))        # angle between source and this ear's axis
        theta = math.degrees(math.acos(cos_t))
        alpha = (1 + 0.1 / 2) + (1 - 0.1 / 2) * math.cos(math.radians(theta * 180 / 150))
        shadow = (1 + 1j * alpha * w / (2 * w0)) / (1 + 1j * w / (2 * w0))
        # Woodworth delay relative to the head centre: ear nearer the source hears it earlier
        lat = math.asin(float(np.clip(d[1], -1, 1))) * ear_y
        tau = -HEAD_R / C * math.sin(lat) if lat >= 0 else HEAD_R / C * abs(lat)
        out.append(shadow * np.exp(-1j * w * (tau + HEAD_R / C)))
    return out


def main():
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "score" / "mix_ambix.wav"
    dst = Path(sys.argv[2]) if len(sys.argv) > 2 else src.with_name("mix_binaural.wav")
    A = read24(src)                                 # W Y Z X (ACN, SN3D)
    W, Y, Z, X = A
    D = speakers()
    g1 = 0.577                                      # max-rE weight for first order
    block, n_fft = 1 << 16, 1 << 17
    out = np.zeros((2, A.shape[1] + n_fft), np.float32)
    filt = [ear_filters(d, n_fft) for d in D]
    for i in range(0, A.shape[1], block):
        sl = slice(i, i + block)
        acc = [np.zeros(n_fft // 2 + 1, complex), np.zeros(n_fft // 2 + 1, complex)]
        for d, (hl, hr) in zip(D, filt):
            spk = (W[sl] + 3 * g1 * (d[0] * X[sl] + d[1] * Y[sl] + d[2] * Z[sl])) / len(D)
            S = np.fft.rfft(spk, n_fft)
            acc[0] += S * hl
            acc[1] += S * hr
        m = min(block, A.shape[1] - i)
        for ch in (0, 1):
            seg = np.fft.irfft(acc[ch], n_fft)[: m + n_fft // 2]
            out[ch, i:i + len(seg)] += seg
    out = out[:, : A.shape[1]]
    out *= 10 ** (-1 / 20) / max(np.abs(out).max(), 1e-9)
    write24(dst, out)
    print(f"{dst}  ({A.shape[1] / SR:.1f}s, 13 virtual speakers, spherical-head binaural)")


if __name__ == "__main__":
    main()
