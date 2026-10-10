#!/usr/bin/env python3
"""Build tools/playground.html — one self-contained page.

Inlines the real shader (shaders/lattice.frag, converted from GLSL 3.30 to
WebGL2's GLSL ES 3.00), the JS port of the lattice + timeline, the UI, and
the repo's current params.json as the starting settings. Re-run after
changing the shader, the timeline or params.json:

  python tools/build_playground.py
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "tools" / "playground"


def shader_es300():
    s = (ROOT / "shaders" / "lattice.frag").read_text()
    head = "#version 330"
    assert s.startswith(head), "shader should start with #version 330"
    return ("#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp sampler3D;\n"
            + s[len(head):].lstrip("\n"))


def main():
    page = (SRC / "template.html").read_text()
    params = json.loads((ROOT / "params.json").read_text())
    parts = {
        "__PARAMS__": json.dumps(params, indent=2).replace("</", "<\\/"),
        "__SHADER__": shader_es300(),
        "__CORE__": (SRC / "core.js").read_text(),
        "__APP__": (SRC / "app.js").read_text(),
    }
    for k, v in parts.items():
        assert page.count(k) == 1, k
        page = page.replace(k, v)
    # the repo copy is a full document you can open straight from disk;
    # --fragment writes the body-only version the claude.ai artifact host wraps itself
    import sys
    if "--fragment" in sys.argv:
        out = Path(sys.argv[sys.argv.index("--fragment") + 1])
        out.write_text(page)
    else:
        out = ROOT / "tools" / "playground.html"
        title_end = page.index("</style>") + len("</style>")
        out.write_text('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
                       '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
                       + page[:title_end] + "\n</head>\n<body>\n" + page[title_end:] + "\n</body>\n</html>\n")
    print(f"{out}  ({out.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
