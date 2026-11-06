"""README screenshots for PDF Reader: real webview (test/e2e/serve.js) + real PDF, on a Chrome started with ~/bin/agent-chrome, over CDP.
Run: python3 scripts/readme-shots/pdf-shots.py <repo> http://127.0.0.1:<port> test/fixtures/earthquakes-october-2026.pdf <outdir>"""
import subprocess, sys
from playwright.sync_api import sync_playwright
ROOT, CDP, PDF, OUT = sys.argv[1:5]
NAME = "earthquakes-october-2026.pdf"

def session(p, theme, scale=2):
    proc = subprocess.Popen(["node", ROOT + "/test/e2e/serve.js", PDF, theme, NAME], stdout=subprocess.PIPE, text=True)
    port = int(proc.stdout.readline())
    b = p.chromium.connect_over_cdp(CDP)
    ctx = b.new_context(viewport={"width": 1280, "height": 760}, device_scale_factor=scale)
    page = ctx.new_page()
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(f"http://127.0.0.1:{port}/harness.html")
    page.wait_for_selector(".page .canvasWrap canvas", timeout=20000)
    page.wait_for_selector(".page .textLayer span", timeout=20000)
    return proc, b, ctx, page, errs

def close(proc, b, ctx):
    ctx.close(); proc.terminate(); proc.wait()

def search(page, word):
    page.fill("#searchInput", word)
    page.wait_for_function("() => document.getElementById('searchCount').textContent.includes('of')", timeout=10000)
    page.wait_for_timeout(900)

with sync_playwright() as p:
    for theme in ("dark", "light"):
        proc, b, ctx, page, errs = session(p, theme)
        page.click("#sidebarBtn"); page.wait_for_selector("#outline a")
        search(page, "Japan")
        page.evaluate("document.getElementById('viewer').scrollTop = 0"); page.wait_for_timeout(900)
        page.screenshot(path=f"{OUT}/pdf-search-{theme}.png")
        if theme == "dark":
            page.click("#tab-thumbs"); page.fill("#searchInput", ""); page.press("#searchInput", "Escape")
            page.select_option("#zoomSelect", "page-fit"); page.click("#thumbs .thumb >> nth=1"); page.wait_for_timeout(1500)
            page.screenshot(path=f"{OUT}/pdf-pages-dark.png")
        else:
            page.click("#outline a >> text=2.1 Magnitudes"); page.wait_for_timeout(300)
            page.fill("#searchInput", ""); page.press("#searchInput", "Escape")
            page.click("#outline a >> text=2. Largest events"); page.wait_for_timeout(1500)
            page.screenshot(path=f"{OUT}/pdf-outline-light.png")
        print(theme, "errors:", errs, page.text_content("#searchCount"))
        close(proc, b, ctx)
