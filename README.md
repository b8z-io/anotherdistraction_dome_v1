# Another Distraction — fulldome piece

A generative fulldome film about attention. A calm, ordered lattice grows
across the dome; bright tangents keep breaking away and pulling the eye off
somewhere else — and every tangent comes back carrying something new. By
the end, the structure is built out of everything that "pulled away".
The detours are the design.

Rendered straight into a **180° equidistant (azimuthal) fisheye
domemaster**: centre of frame = zenith, bottom of frame = front of the
audience, frame edge = springline. The same shader can also output an
**equirectangular** frame for checking in a VR headset.

---

## How it stays repeatable

* **Every frame is a pure function of `(time, params.json)`.** Nothing is
  simulated frame-to-frame, so frame 4,000 renders without frames 1–3,999,
  and the same frame comes out byte-identical every time on the same setup.
* **All the knobs live in `params.json`.** A "tweak" is a one- or two-line
  change there, committed to git. Any earlier version can be checked out and
  re-rendered exactly.
* **Resolution-independent.** Composition is defined in angles on the dome,
  not pixels — a 768px preview and an 8K final are the same picture, sharper.
* **Changing `seed`** gives a completely different lattice with the same
  character; everything else stays put.

Different GPUs/drivers can differ by the odd pixel value in the last bit of
precision (invisible), but nothing accumulates, so they never drift apart.

## Files

| File | What it is |
|---|---|
| `params.json` | Every knob for the piece. |
| `lattice.py` | Builds the growth graph from `params.json`: a seeded shortest-path tree on a sparse cubic lattice, so every branch connects back to the seed and growth travels along branches. Run it on its own to print stats. |
| `shaders/lattice.frag` | The piece itself — a GLSL raymarcher that renders the graph straight into the fisheye. |
| `render.py` | Headless renderer: contact sheets, image sequences, VR previews. |
| `previews/` | Contact sheets and preview clips, versioned by name (`seed_v2_…`). |
| `frames/` | Rendered image sequences (git-ignored). |

## Setup

Python 3.10+ and any GPU with OpenGL 3.3 (Mac: built-in OpenGL 4.1 is fine).

```bash
git clone git@github.com:b8z-io/another-distraction.git
cd another-distraction
python3 -m venv .venv && source .venv/bin/activate     # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

`render.py` picks the right OpenGL context per platform (EGL on Linux,
default on Mac/Windows) — no edits needed.

## Rendering

```bash
# contact sheet of chosen moments (fast — use this for every tweak)
python render.py --times 0 6 10 14 18 22 26 30 34 38 42 45 --sheet previews/sheet.png

# preview sequence at 512px, then encode to a clip
python render.py --range 0 45 --res 512 --out frames/seed_512
ffmpeg -framerate 30 -pattern_type glob -i 'frames/seed_512/frame_*.png' \
       -c:v libx264 -crf 14 -pix_fmt yuv420p previews/seed_512.mp4

# finals: 4K domemaster, 2×2 supersampled
python render.py --range 0 45 --res 4096 --ss 2 --out frames/4k

# VR-headset check (2:1 equirectangular)
python render.py --times 40 --proj equirect --res 2048 --out frames/vr
```

Frames are named by frame number at the project fps (`frame_01350.png` =
45.0s at 30fps), so partial renders and re-renders slot straight into an
existing sequence for Resolve.

## The tweak loop

1. Say what you want ("growth should start sooner", "more teal").
2. One or two values in `params.json` change (or the shader, for new behaviour).
3. Contact sheet re-rendered → commit → look → repeat.
4. Once a section's locked, render a preview clip, then finals on a GPU.

## `params.json` reference

**Top level**
* `seed` — integer. Picks which lattice grows. Change it for a whole new structure.

**`output`**
* `projection` — `domemaster` or `equirect`.
* `fov_deg` — fisheye field of view (180 = hemisphere; >180 for domes that need overscan).
* `tilt_deg` — dome tilt. Tips the zenith toward the front for tilted/unidirectional domes.
* `fps` — frame rate (30 now; 60 is a parameter change, not a rebuild).
* `preview_res` — default square size when `--res` isn't given.
* `supersample` — samples per pixel per axis (2 = 4 samples). Kills shimmer on thin struts.

**`lattice`** — the ordered structure
* `cell` — spacing between lattice nodes (world units; the audience is at the origin).
* `site_density` — fraction of lattice sites that can grow (lower = sparser, more elegant).
* `edge_weight_range` — random "cost" range per strut. Wider = more irregular, wandering growth order.
* `crosslink_density` / `crosslink_delay` — extra struts bridging two grown branches, appearing this far (in path units) behind the growth front. Makes it more crystal, less tree.
* `rotation_deg` — orientation of the lattice in the sky.
* `audience_void_radius` — nothing grows closer than this to the audience.
* `extent` — how far out the lattice can ever grow.
* `strut_radius` / `node_radius` — thickness of struts and joints.

**`seed_point`** — the opening star
* `position` — where the seed sits (x right, y up, −z front). Also where growth starts.
* `star_fade_in_s` — fade-in start/end, seconds.
* `star_intensity`, `star_size_rad` — brightness and size (radians).

**`growth`**
* `start_s` / `end_s` — when growth starts and when this section's growth ends.
* `end_path` — how far along the branches the front has travelled by `end_s` (bigger = more of the dome covered).
* `curve_power` — easing. >1 starts slow and accelerates; 1 = constant pace.

**`look`**
* `col_deep` — the deep-blue of distant struts and glow haze.
* `col_strut` — near struts. `col_tip` — growing tips and the star.
* `glow`, `glow_width` — soft halo around struts. `tip_glow` — brightness of growing tips.
* `fog_distance` — how quickly distance fades struts into `col_deep`.
* `exposure` — overall brightness before tone-mapping (ACES). Keep the dome dark: a concave screen reflects onto itself.

**`render`**
* `steps`, `far` — raymarch quality limits. Rarely need touching.

## Sections

| # | Section | Time | Status |
|---|---|---|---|
| 1 | **Seed** — star at the zenith grows into a cool, ordered lattice | 0:00–0:45 | ✅ v2 |
| 2 | **First tug** — sound cue first, then a bright ribbon breaks away toward the horizon and returns warm, colour seeping into the lattice | 0:45–1:30 | — |
| 3 | **Escalation + hyperfocus** — competing threads; then everything snaps to one tangent that blooms to fill the dome (flow, as joy) | 1:30–3:00 | — |
| 4 | **Overload → darkness** — too many threads, then a hard cut to black and silence | 3:00–3:45 | — |
| 5 | **Rebuild** — the lattice regrows from every colour the tangents brought back | 3:45–5:00 | — |

Visual grammar: the lattice is slow, orthogonal and ordered; tangents are
fast, fluid, bright ribbons. Sound: a drone under the lattice, one motif per
tangent, panned to where it appears on the dome (separate stems).

## Pipeline

* **Here / any machine:** shader + params + previews.
* **GPU machine:** 4K/8K finals with the same `render.py`.
* **ComfyUI:** look-dev only (style frames, palettes) — not the piece itself.
* **DaVinci Resolve:** conform sequences, lay in soundtrack, grade, deliver
  (Resolve Studio needed for output above 4K).

## Version history

* **Seed v1** — stateless hash-driven lattice. Issues: ~14s of dead air before growth, orphan fragments floating unconnected, flat white look.
* **Seed v2** — precomputed growth graph (no orphans, growth travels along branches, ~10× faster), first branch by ~8s, true-black sky, cooler struts, brighter tips, 2× supersampling.
