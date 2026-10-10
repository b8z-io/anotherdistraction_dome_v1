# Another Distraction — fulldome piece

Generative fulldome film, rendered straight into a 180° equidistant
fisheye domemaster (bottom of frame = front, centre = zenith).

* `shaders/lattice.frag` — the piece. Every frame is a pure function of
  time + `params.json`, so any frame renders identically on any machine,
  at any resolution.
* `params.json` — every knob. Tweak, commit, re-render.
* `render.py` — headless renderer (moderngl, OpenGL 3.3).

```
pip install moderngl numpy pillow
python render.py --times 0 10 20 30 45 --sheet sheet.png      # contact sheet
python render.py --range 0 45 --res 1024 --out frames/seed     # preview sequence
python render.py --range 0 45 --res 4096 --ss 2 --out frames/4k
python render.py --times 40 --proj equirect --res 2048         # VR-headset preview
```

On a desktop GPU drop `backend="egl"` in `Renderer.__init__` if EGL
isn't available (macOS: use `moderngl.create_standalone_context()`).

## Sections
1. Seed (0:00–0:45) — star at zenith grows into a cool, ordered lattice. ✅ v1
2. First tug — a tangent breaks away and returns warm.
3. Escalation + hyperfocus bloom.
4. Overload → darkness.
5. Rebuild from everything the tangents brought back.
