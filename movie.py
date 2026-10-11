#!/usr/bin/env python3
"""Stitch a rendered frame folder into a movie — no separate ffmpeg install needed.

Uses the ffmpeg bundled with the imageio-ffmpeg pip package (in requirements.txt),
falling back to a system ffmpeg if one is on PATH. Frame rate comes from params.json.

  python movie.py frames/seed_512                      # -> frames/seed_512.mp4 (H.264)
  python movie.py frames/4k --codec prores             # -> frames/4k.mov  (ProRes 422 HQ, for Resolve)
  python movie.py frames/4k --codec hevc -o seed.mp4   # HEVC, smaller files for review at 4K+
  python movie.py frames/prev --audio score/mix_stereo.wav   # with the soundtrack from score.py
  python movie.py frames/reel --audio score/mix_stereo.wav --size-mb 30 --fade-in 1
        # 2-pass H.264 sized to land just under 30 MB (phone / Instagram / chat-upload limits)
"""
import argparse, json, re, shutil, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent

CODECS = {
    "h264":   (".mp4", ["-c:v", "libx264", "-crf", "14", "-preset", "slow", "-pix_fmt", "yuv420p"]),
    "hevc":   (".mp4", ["-c:v", "libx265", "-crf", "16", "-tag:v", "hvc1", "-pix_fmt", "yuv420p", "-x265-params", "log-level=error"]),
    "prores": (".mov", ["-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le"]),
}


def ffmpeg_exe():
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        exe = shutil.which("ffmpeg")
        if exe:
            return exe
        sys.exit("ffmpeg not found — run:  pip install -r requirements.txt")


def make_movie(frames_dir, out=None, codec="h264", fps=None, params=None, audio=None, size_mb=None, fade_in=0.0):
    frames_dir = Path(frames_dir)
    nums = sorted(int(m.group(1)) for f in frames_dir.glob("frame_*.png")
                  if (m := re.fullmatch(r"frame_(\d+)\.png", f.name)))
    if not nums:
        sys.exit(f"no frame_*.png files in {frames_dir}")
    missing = sorted(set(range(nums[0], nums[-1] + 1)) - set(nums))
    if missing:
        sys.exit(f"{len(missing)} frame(s) missing, first is frame_{missing[0]:05d}.png — re-render those first")
    if fps is None:
        fps = json.loads(Path(params or ROOT / "params.json").read_text())["output"]["fps"]
    ext, args = CODECS[codec]
    out = Path(out) if out else frames_dir.with_suffix(ext)
    dur = len(nums) / fps
    a_rate = 160 if size_mb else 320
    cmd = [ffmpeg_exe(), "-y", "-loglevel", "error", "-stats",
           "-framerate", str(fps), "-start_number", str(nums[0]),
           "-i", str(frames_dir / "frame_%05d.png")]
    if audio:
        # audio sample 0 = t 0s; offset it to the first frame so a partial render stays in sync
        cmd += ["-ss", f"{nums[0] / fps:.6f}", "-i", str(audio), "-map", "0:v", "-map", "1:a", "-shortest"]
        cmd += ["-c:a", "pcm_s24le"] if codec == "prores" else ["-c:a", "aac", "-b:a", f"{a_rate}k"]
    if fade_in:
        cmd += ["-vf", f"fade=t=in:st=0:d={fade_in}"]
        if audio:
            cmd += ["-af", f"afade=t=in:st=0:d={fade_in}"]
    if size_mb:
        # pick the video bitrate that fills the target size (decimal MB, ~1.5% container overhead)
        assert codec == "h264", "--size-mb is for H.264 deliverables"
        v_kbps = int(size_mb * 8000 * 0.985 / dur - (a_rate if audio else 0))
        enc = ["-c:v", "libx264", "-preset", "slow", "-profile:v", "high", "-pix_fmt", "yuv420p",
               "-b:v", f"{v_kbps}k", "-maxrate", f"{int(v_kbps * 2)}k", "-bufsize", f"{int(v_kbps * 4)}k"]
        log = str(out.with_suffix("")) + "_2pass"
        first = list(cmd)
        # pass 1: video only, analysis to a log file
        p1 = [ffmpeg_exe(), "-y", "-loglevel", "error", "-framerate", str(fps), "-start_number", str(nums[0]),
              "-i", str(frames_dir / "frame_%05d.png")]
        if fade_in:
            p1 += ["-vf", f"fade=t=in:st=0:d={fade_in}"]
        subprocess.run(p1 + enc + ["-pass", "1", "-passlogfile", log, "-an", "-f", "null", "-"], check=True)
        subprocess.run(first + enc + ["-pass", "2", "-passlogfile", log, "-movflags", "+faststart", str(out)], check=True)
        for f in Path(log).parent.glob(Path(log).name + "*"):
            f.unlink()
        print(f"{out}  ({len(nums)} frames, {dur:.2f}s, {v_kbps} kbps video, {out.stat().st_size / 1e6:.1f} MB)")
        return out
    cmd += [*args, str(out)]
    subprocess.run(cmd, check=True)
    print(f"{out}  ({len(nums)} frames, {dur:.2f}s at {fps}fps, {codec})")
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("frames", help="folder of frame_NNNNN.png files")
    ap.add_argument("-o", "--out", help="output file (default: <folder>.mp4 / .mov)")
    ap.add_argument("--codec", choices=CODECS, default="h264")
    ap.add_argument("--fps", type=float, help="override fps from params.json")
    ap.add_argument("--params", help="params.json to read fps from")
    ap.add_argument("--audio", help="soundtrack to lay in, e.g. score/mix_stereo.wav (from score.py)")
    ap.add_argument("--size-mb", type=float, help="2-pass H.264 sized to land just under this many MB")
    ap.add_argument("--fade-in", type=float, default=0.0, help="fade picture (and sound) up from black, seconds")
    a = ap.parse_args()
    make_movie(a.frames, a.out, a.codec, a.fps, a.params, a.audio, a.size_mb, a.fade_in)
