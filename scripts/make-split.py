"""Builds images/light-vs-dark.png from the two real screenshots: left half light theme, right half dark."""
import pathlib
from PIL import Image, ImageDraw
root = pathlib.Path(__file__).resolve().parent.parent / "images"
light = Image.open(root / "screenshot-light.png").convert("RGB")
dark = Image.open(root / "screenshot-dark.png").convert("RGB")
w, h = light.size
# crop to the page column so both halves show the same part of the page
# box in CSS pixels of a 1280 px wide viewport, scaled to the screenshot's device pixel ratio
k = w / 1280
box = tuple(round(v * k) for v in (250, 34, 1250, min(800, h / k)))
l = light.crop(box)
d = dark.crop(box)
cw = l.size[0]
out = Image.new("RGB", l.size)
out.paste(l.crop((0, 0, cw // 2, l.size[1])), (0, 0))
out.paste(d.crop((cw // 2, 0, cw, l.size[1])), (cw // 2, 0))
ImageDraw.Draw(out).line([(cw // 2, 0), (cw // 2, l.size[1])], fill=(0, 120, 212), width=3)
out.save(root / "light-vs-dark.png", optimize=True)
print(out.size)
