"""Builds test/fixtures/sample.pdf: 4 pages, headings (PDF outline), text, two raster images.

Run: python3 scripts/make-sample.py  (needs Python Playwright with a Chromium headless shell, and rsvg-convert)
The PDF is fictional content made for tests and the README screenshot.
"""
import base64
import pathlib
import subprocess
import sys
import tempfile

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "test" / "fixtures" / "sample.pdf"

PHOTO_SVG = """<svg xmlns="http://www.w3.org/2000/svg" width="640" height="300">
<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4f9de8"/><stop offset="1" stop-color="#f7c873"/></linearGradient></defs>
<rect width="640" height="300" fill="url(#sky)"/><circle cx="500" cy="90" r="42" fill="#fff3b0"/>
<path d="M0 230 L120 140 L220 210 L330 110 L450 220 L560 160 L640 210 L640 300 L0 300 Z" fill="#2f6b3a"/>
<path d="M0 260 L160 200 L300 250 L470 205 L640 255 L640 300 L0 300 Z" fill="#1f4d2a"/></svg>"""

CHART_SVG = """<svg xmlns="http://www.w3.org/2000/svg" width="560" height="240">
<rect width="560" height="240" fill="#ffffff"/>
<g fill="#3b82f6"><rect x="40" y="140" width="50" height="80"/><rect x="120" y="100" width="50" height="120"/><rect x="200" y="60" width="50" height="160"/></g>
<g fill="#ef4444"><rect x="300" y="170" width="50" height="50"/><rect x="380" y="130" width="50" height="90"/><rect x="460" y="40" width="50" height="180"/></g>
<line x1="30" y1="220" x2="540" y2="220" stroke="#111" stroke-width="2"/></svg>"""


def png_data_uri(svg: str, tmp: pathlib.Path, name: str) -> str:
    src = tmp / f"{name}.svg"
    dst = tmp / f"{name}.png"
    src.write_text(svg)
    subprocess.run(["rsvg-convert", "-o", str(dst), str(src)], check=True)
    return "data:image/png;base64," + base64.b64encode(dst.read_bytes()).decode()


def html(photo: str, chart: str) -> str:
    para = (
        "The edge cache cut median latency from 180 ms to 42 ms in the first week. "
        "We measured latency at three regions and kept the slowest one as the baseline. "
        "Cold starts still add latency on the first request after a deploy. "
    )
    body = [
        "<h1>Field Report: Edge Cache Rollout</h1>",
        "<p>Prepared for the platform team. All numbers in this sample are made up.</p>",
        "<h2>1. Summary</h2>",
        f"<p>{para}</p>",
        f'<img src="{photo}" alt="Mountain photo" style="width:100%">',
        "<p>The photo above is a raster image. In dark mode the page turns dark, but the photo keeps its colors.</p>",
        '<h2 style="page-break-before:always">2. Results</h2>',
        f"<p>{para * 2}</p>",
        f'<img src="{chart}" alt="Bar chart" style="width:80%">',
        "<h3>2.1 Latency by region</h3>",
        "<table border='1' cellpadding='6' style='border-collapse:collapse'><tr><th>Region</th><th>Before</th><th>After</th></tr>"
        "<tr><td>Frankfurt</td><td>170 ms</td><td>39 ms</td></tr><tr><td>Singapore</td><td>210 ms</td><td>51 ms</td></tr>"
        "<tr><td>Virginia</td><td>160 ms</td><td>36 ms</td></tr></table>",
        '<h2 style="page-break-before:always">3. Next steps</h2>',
        f"<p>{para}</p><ul><li>Warm the cache after each deploy.</li><li>Alert when p95 latency passes 120 ms.</li></ul>",
        '<h2 style="page-break-before:always">Appendix A. Method</h2>',
        f"<p>{para * 3}</p>",
    ]
    return (
        "<!doctype html><html><head><meta charset='utf-8'><style>"
        "body{font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:1.5;color:#111;margin:0}"
        "h1{font-size:26px}h2{font-size:19px;margin-top:22px}h3{font-size:15px}"
        "</style></head><body>" + "".join(body) + "</body></html>"
    )


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="pdfviewer-sample-") as t:
        tmp = pathlib.Path(t)
        photo = png_data_uri(PHOTO_SVG, tmp, "photo")
        chart = png_data_uri(CHART_SVG, tmp, "chart")
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            try:
                page = browser.new_page()
                page.set_content(html(photo, chart))
                page.pdf(path=str(OUT), format="A4", margin={"top": "18mm", "bottom": "18mm", "left": "18mm", "right": "18mm"},
                         outline=True, tagged=True)
            finally:
                browser.close()
    print(OUT, OUT.stat().st_size, "bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
