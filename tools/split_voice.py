#!/usr/bin/env python3
"""Split one narration take into a clip per credo card and re-time the cards.

  python tools/split_voice.py assets/voice/softly/take3.mp3            # split + re-time params.json
  python tools/split_voice.py take.mp3 --dry-run                        # just print what it found

The take must read the cards in order with a clear pause between them (an
ElevenLabs [pause] tag is plenty). The N-1 longest silences become the cut
points; each clip is trimmed to its speech with a short fade either side and
written as assets/voice/line<k>.wav (48 kHz, 16-bit, mono).

Then the cards are re-timed from the clip lengths, starting at the first
card's current 'in' time:
  voice_at = in + lead
  out      = voice_at + clip + hold + row_hold * (rows - 1)
  next in  = out + gap
The last card keeps its 'out' time if that still leaves `hold` after the voice
ends, and the credit appears `credit_after` seconds after the last voice starts.
Re-run score.py afterwards (render frames only need params.json).
"""
import argparse, json, subprocess, wave
from pathlib import Path

import numpy as np
import imageio_ffmpeg

ROOT = Path(__file__).resolve().parents[1]
SR = 48000


def decode(path):
    raw = subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-v", "quiet", "-i", str(path),
                          "-f", "f32le", "-ac", "1", "-ar", str(SR), "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32).copy()


def silences(x, floor_db=38, min_s=0.18, hop_s=0.01):
    hop = int(SR * hop_s)
    n = len(x) // hop
    db = 20 * np.log10(np.sqrt((x[: n * hop].reshape(n, hop) ** 2).mean(1) + 1e-12))
    quiet = db < db.max() - floor_db
    out, i = [], 0
    while i < n:
        if quiet[i]:
            j = i
            while j < n and quiet[j]:
                j += 1
            out.append((i * hop_s, j * hop_s, i == 0 or j == n))
            i = j
        else:
            i += 1
    return out, [s for s in out if not s[2] and s[1] - s[0] >= min_s]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("take")
    ap.add_argument("--params", default=str(ROOT / "params.json"))
    ap.add_argument("--lead", type=float, default=0.7)
    ap.add_argument("--hold", type=float, default=1.6)
    ap.add_argument("--row-hold", type=float, default=0.5)
    ap.add_argument("--gap", type=float, default=0.6)
    ap.add_argument("--credit-after", type=float, default=1.4)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    P = json.loads(Path(a.params).read_text())
    cards = P["quote"]["cards"]
    x = decode(a.take)
    every, gaps = silences(x)
    cuts = sorted(sorted(gaps, key=lambda g: g[1] - g[0])[-(len(cards) - 1):])
    assert len(cuts) == len(cards) - 1, f"found {len(gaps)} pauses, need {len(cards) - 1}"
    head = every[0][1] if every and every[0][0] == 0 else 0.0
    tail = every[-1][0] if every and every[-1][2] and every[-1][0] > 0 else len(x) / SR
    bounds = [head] + [v for c in cuts for v in c[:2]] + [tail]
    pre, post, fade = 0.04, 0.15, 0.02
    durs = []
    for k, c in enumerate(cards):
        s, e = bounds[2 * k], bounds[2 * k + 1]
        i0, i1 = max(0, int((s - pre) * SR)), min(len(x), int((e + post) * SR))
        clip = x[i0:i1].copy()
        nf = int(fade * SR)
        clip[:nf] *= np.linspace(0, 1, nf)
        clip[-nf:] *= np.linspace(1, 0, nf)
        durs.append(round(len(clip) / SR, 2))
        print(f"line{k + 1}: {s:6.2f}–{e:6.2f}s in the take  ->  {durs[-1]:.2f}s clip   {' / '.join(c['rows'])}")
        if not a.dry_run:
            with wave.open(str(ROOT / c["voice"]), "wb") as w:
                w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
                w.writeframes((np.clip(clip, -1, 1) * 32767).astype("<i2").tobytes())

    last_out = cards[-1]["out"]
    t = cards[0]["in"]
    for k, (c, d) in enumerate(zip(cards, durs)):
        c["in"] = round(t, 2)
        c["voice_at"] = round(t + a.lead, 2)
        c["out"] = round(c["voice_at"] + d + a.hold + a.row_hold * (len(c["rows"]) - 1), 2)
        t = c["out"] + a.gap
    c = cards[-1]
    c["out"] = max(c["out"], last_out)
    P["quote"]["credit_in"] = round(c["voice_at"] + a.credit_after, 2)
    for c in cards:
        print(f"  in {c['in']:7.2f}  voice {c['voice_at']:7.2f}  out {c['out']:7.2f}")
    print(f"  credit {P['quote']['credit_in']:.2f}")
    if not a.dry_run:
        Path(a.params).write_text(json.dumps(P, indent=2) + "\n")
        meta = ROOT / "assets" / "voice" / "lines.json"
        take = Path(a.take).resolve()
        take = str(take.relative_to(ROOT)) if take.is_relative_to(ROOT) else a.take
        meta.write_text(json.dumps({"take": take, "durations": durs}, indent=1) + "\n")


if __name__ == "__main__":
    main()
