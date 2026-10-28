"""由 assets/app-icon.png（1024×1024）导出多尺寸 assets/app-icon.ico（16~256 七档）。

用法：先 `node assets/make-icon.mjs` 生成 SVG 与 PNG，再 `python assets/make-icon.py`。
依赖 Pillow：`pip install pillow`。
"""
import os

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
PNG = os.path.join(HERE, "app-icon.png")
ICO = os.path.join(HERE, "app-icon.ico")
SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]

src = Image.open(PNG).convert("RGBA")
if src.size != (1024, 1024):
    src = src.resize((1024, 1024), Image.LANCZOS)
src.save(ICO, sizes=SIZES)

with Image.open(ICO) as ico:
    got = sorted(ico.info.get("sizes", []))
print("wrote app-icon.ico: %s" % ", ".join("%dx%d" % s for s in got))
if got != SIZES:
    raise SystemExit("unexpected ICO sizes: %s" % got)
