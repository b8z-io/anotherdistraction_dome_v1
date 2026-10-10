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

## How it fits together

```
params.json ──► lattice.py ──► timeline.py ──┬──► render.py ─► frames ─┐
 (every knob)   (growth graph)  (one shared    │   (+ lattice.frag)      ├─► movie.py ─► .mp4 / .mov
                                 timeline)     └──► score.py ─► .wav ────┘
```

`timeline.py` is the single source of truth for *when* and *where*: growth
front, camera, each tangent's flight, landing and colour spread. The picture
and the sound both read it, so a tangent's sound comes from where its ribbon
is, on the exact frame — change a time in `params.json` and both move together.

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
| `timeline.py` | The shared timeline: growth front, camera pose, tangent ribbons, landing flashes, colour spread — all pure functions of time. |
| `score.py` | The procedural soundtrack, generated from the timeline: stereo mix, AmbiX (first-order ambisonics) for dome speaker arrays, and stems. |
| `lattice.py` | Builds the growth graph from `params.json`: a seeded shortest-path tree on a sparse cubic lattice, so every branch connects back to the seed and growth travels along branches. Run it on its own to print stats. |
| `shaders/lattice.frag` | The piece itself — a GLSL raymarcher that renders the graph straight into the fisheye. |
| `render.py` | Headless renderer: contact sheets, image sequences, VR previews. |
| `movie.py` | Stitches a frame folder into H.264 / HEVC / ProRes — bundled ffmpeg, nothing extra to install. |
| `previews/` | Contact sheets and preview clips, versioned by name (`seed_v2_…`). |
| `frames/` | Rendered image sequences (git-ignored). |
| `score/` | Generated audio (git-ignored — re-run `score.py`, it's deterministic). |

## Setup

Python 3.10+ and any GPU with OpenGL 3.3 (Mac: built-in OpenGL 4.1 is fine).

```bash
git clone git@github.com:b8z-io/anotherdistraction_dome_v1.git
cd anotherdistraction_dome_v1
python3 -m venv .venv && source .venv/bin/activate     # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

`render.py` picks the right OpenGL context per platform (EGL on Linux,
default on Mac/Windows) — no edits needed.

## Rendering

```bash
# contact sheet of chosen moments (fast — use this for every tweak)
python render.py --times 0 6 10 14 18 22 26 30 34 38 42 45 --sheet previews/sheet.png

# preview sequence at 512px + an H.264 movie of it (frames/seed_512.mp4)
python render.py --range 0 45 --res 512 --out frames/seed_512 --movie

# finals: 4K domemaster, 2×2 supersampled
python render.py --range 0 45 --res 4096 --ss 2 --out frames/4k --movie prores

# soundtrack, then a preview with sound
python score.py --end 90
python render.py --range 0 90 --res 512 --out frames/prev --movie --audio score/mix_stereo.wav

# VR-headset check (2:1 equirectangular)
python render.py --times 40 --proj equirect --res 2048 --out frames/vr
```

### Stitching frames into a movie

`movie.py` does it with the ffmpeg that `pip install -r requirements.txt`
brings along (imageio-ffmpeg) — no Homebrew or separate ffmpeg install.
Frame rate comes from `params.json`.

```bash
python movie.py frames/seed_512                      # H.264 .mp4, plays anywhere (fine up to ~2K)
python movie.py frames/4k --codec prores             # ProRes 422 HQ .mov, for Resolve
python movie.py frames/4k --codec hevc -o seed.mp4   # HEVC, smaller files for reviewing 4K+
python movie.py frames/prev --audio score/mix_stereo.wav   # lay in the soundtrack
```

`--audio` offsets the soundtrack to the first frame, so a partial render
(say 60–90s) still lines up.

Or add `--movie [h264|hevc|prores]` to any `render.py --range` run. Resolve
can also import a frame folder directly as an image sequence.

Frames are named by frame number at the project fps (`frame_01350.png` =
45.0s at 30fps), so partial renders and re-renders slot straight into an
existing sequence for Resolve.

## The soundtrack

`score.py` writes to `score/`:

* `mix_stereo.wav` — the stereo mix (24-bit / 48 kHz).
* `mix_ambix.wav` — first-order ambisonics (AmbiX: ACN/SN3D, W Y Z X), for decoding to a dome's speaker array. Directions are relative to the audience's front, so it follows the camera's turn.
* `stem_drone.wav`, `stem_pings.wav`, `stem_paint.wav`, `stem_tangents.wav`, `stem_reverb.wav` — they sum to the stereo mix; use them to rebalance in Resolve.

What you hear:

* **Drone** (D/A) — the lattice. Its upper partials open as it grows; a faint high D is the seed star.
* **Pings** — every node that switches on rings a soft bell in D pentatonic, pitched by its height on the dome and panned to where it is. Early on you hear single notes; by 45s it's a shimmer.
* **Paint** — every strut a tangent paints chimes in that tangent's chord as the colour reaches it, so the harmony shifts as the colour spreads.
* **Tangents** — each one's motif starts `precue_s` *before* the ribbon appears, from where it will emerge — the ears get distracted first — then follows the ribbon round the dome, with a whoosh that rides its speed. Landing: a chord blooms where it touches down, with a low thump. A warm pad in that chord then holds for as long as its colour stays in the lattice.

An AI music bed (ElevenLabs Music / video-to-music) can sit under this later;
the procedural layer is the part that's locked to picture.

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

**Keyframes.** Anything that changes over the piece is a list of
`[seconds, value]` pairs, joined by a smooth curve that never overshoots and
holds its first/last value outside the range.

**`growth`**
* `front_keys` — how far along the branches the growth front has travelled at each time (path units). Steeper = faster growth; flat = growth pauses.

**`camera`** — the audience's viewpoint
* `x_keys`, `y_keys`, `z_keys` — position over time (y is up; the audience starts at the origin). Rising (y) is the gentlest motion on a dome.
* `yaw_keys` — slow turn about the zenith, degrees (positive = front turns toward the right). Keep it under ~1°/s.
* `void_inner` / `void_outer` — nothing closer than `void_inner` to the audience; struts fade in out to `void_outer`.

**`tangents`** — a list; each one is a distraction. Directions are `[azimuth, elevation]` relative to the audience (az 0 front, 90 right, 180 behind; el 0 horizon, 90 zenith).
* `launch_s`, `flight_s`, `absorb_s` — when it peels off a node, how long it flies, how long the tail takes to sink in after landing.
* `from_dir` — roughly where on the dome it breaks away (the nearest grown node is used).
* `out_dir`, `out_dist`, `loop_radius` — where it swings out to, how far, and the size of the loop it makes there.
* `land_dir` — roughly where it lands.
* `color` — its own hue; every tangent gets a different one (see `paint._palette`).
* `width`, `trail`, `intensity` — the ribbon. `head_glow`, `head_size` — the comet's glowing head. `flash_size` — the landing flash.
* `spread_speed`, `spread_limit`, `pulse` — how fast its colour travels through the lattice from the landing node, how far it can reach (path units), and how bright the travelling wavefront is.
* `hue_spread_deg`, `hue_time_s` — how far the stain's hue drifts from the ribbon's own colour (e.g. gold → orange → amber), reached this many seconds after landing.
* `precue_s` — how early its sound starts before it appears.
* `sound` — `motif` (notes it plays in flight), `chord` (landing bloom + pad), and levels.

**`look`**
* `col_deep` — the deep-blue of distant struts and glow haze.
* `col_strut` — near struts. `col_tip` — growing tips and the star.
* `glow`, `glow_width` — soft halo around struts. `tip_glow` — brightness of growing tips.
* `fog_distance` — how quickly distance fades struts into `col_deep`.
* `exposure` — overall brightness before tone-mapping (ACES). Keep the dome dark: a concave screen reflects onto itself.

**`paint`** — how tangents colour the lattice. A strut gets painted two ways: the ribbon *brushes* it in flight, or the *stain* spreads to it from the landing node.
* `_palette` — the hues to draw tangent colours from (kept clear of the lattice's blue).
* `brush_radius` — how close the comet's head must pass to paint a node; `brush_reach`, `brush_speed` — how far, and how fast, brushed colour bleeds from there.
* `fade_in_s`, `pulse_s` — how quickly colour arrives at a strut, and how long its arrival flashes.
* `tint_amount` — how fully colour replaces the cool base. `hue_jitter_deg` — node-to-node hue variety. `vivid` — brightness of painted struts.

**`score`**
* `drone` — `notes`, `level`, `star_note`, `star_level`.
* `pings` — `level` (growth). `paint` — `level` (chimes as colour reaches each strut).
* `reverb_send` (per layer), `reverb_level`, `master_peak_db`.

**`render`**
* `steps`, `far` — raymarch quality limits. Rarely need touching.

## Sections

| # | Section | Time | Status |
|---|---|---|---|
| 1 | **Seed** — star at the zenith grows into a cool, ordered lattice | 0:00–0:45 | ✅ v2 |
| 2 | **First tug** — sound cue first, then a bright comet breaks away toward the horizon, painting struts as it passes, and lands in a burst of colour that spreads through the lattice; the audience starts to rise | 0:45–1:30 | ✅ v2 |
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
* **First tug v2** — brighter comets (white-hot core, saturated halo, glowing head), a different vivid colour per tangent (gold, magenta), ribbons paint struts they brush past in flight, bigger multi-hued stains that drift within each colour's family, paint chimes in each tangent's chord.
* **First tug v1** — shared timeline; camera still through section 1, then a slow rise and gentle turn; two tangents (amber, rose) with landing flashes and colour spreading through the lattice; procedural score (drone, node pings, tangent motifs with pre-cue, whoosh, bloom, pad) in stereo + AmbiX.
* **Seed v2** — precomputed growth graph (no orphans, growth travels along branches, ~10× faster), first branch by ~8s, true-black sky, cooler struts, brighter tips, 2× supersampling.
