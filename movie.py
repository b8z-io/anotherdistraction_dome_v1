#!/usr/bin/env python3
"""Stitch a rendered frame folder into a movie — no separate ffmpeg install needed.

Uses the ffmpeg bundled with the imageio-ffmpeg pip package (in requirements.txt),
falling back to a system ffmpeg if one is on PATH. Frame rate comes from params.json.

  python movie.py frames/seed_512                      # -> frames/seed_512.mp4 (H.264)
  python movie.py frames/4k --codec prores             # -> frames/4k.mov  (ProRes 422 HQ, for Resolve)
  python movie.py frames/4k --codec hevc -o seed.mp4   # HEVC, smaller files for review at 4K+
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


def make_movie(frames_dir, out=None, codec="h264", fps=None, params=None):
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
    cmd = [ffmpeg_exe(), "-y", "-loglevel", "error", "-stats",
           "-framerate", str(fps), "-start_number", str(nums[0]),
           "-i", str(frames_dir / "frame_%05d.png"), *args, str(out)]
    subprocess.run(cmd, check=True)
    print(f"{out}  ({len(nums)} frames, {len(nums) / fps:.2f}s at {fps}fps, {codec})")
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("frames", help="folder of frame_NNNNN.png files")
    ap.add_argument("-o", "--out", help="output file (default: <folder>.mp4 / .mov)")
    ap.add_argument("--codec", choices=CODECS, default="h264")
    ap.add_argument("--fps", type=float, help="override fps from params.json")
    ap.add_argument("--params", help="params.json to read fps from")
    a = ap.parse_args()
    make_movie(a.frames, a.out, a.codec, a.fps, a.params)
