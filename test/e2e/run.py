"""Browser test of the real webview (headless Chromium via Python Playwright).

Starts test/e2e/serve.js, opens the harness, and checks: pages render, outline loads, search finds and
highlights matches, dark mode darkens the page but keeps the photo's colors, CSP has no violations.
With --shot PATH it also saves the README screenshot.

Run: python3 test/e2e/run.py [--shot images/screenshot-dark.png] [--light-shot images/screenshot-light.png]
Set PDFV_CDP=http://127.0.0.1:<port> to use an already running Chrome (for example one from agent-chrome) over CDP.
"""
import argparse
import json
import os
import pathlib
import subprocess
import sys

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[2]


def start_server(theme):
    proc = subprocess.Popen(["node", str(ROOT / "test/e2e/serve.js"), str(ROOT / "test/fixtures/sample.pdf"), theme],
                            stdout=subprocess.PIPE, text=True)
    port = int(proc.stdout.readline().strip())
    return proc, port


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + (f"  ({detail})" if detail else ""))
    return ok


def run_theme(p, theme, shot, thumbs_shot=None):
    proc, port = start_server(theme)
    results = []
    try:
        cdp = os.environ.get("PDFV_CDP")
        browser = p.chromium.connect_over_cdp(cdp) if cdp else p.chromium.launch(headless=True)
        try:
            page = browser.new_context(viewport={"width": 1280, "height": 800}, device_scale_factor=1).new_page()
            errors = []
            page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(f"http://127.0.0.1:{port}/harness.html")
            page.wait_for_selector(".page .canvasWrap canvas", timeout=20000)
            page.wait_for_selector(".page .textLayer span", timeout=20000)
            pages = page.eval_on_selector_all(".page", "els => els.length")
            results.append(check(f"[{theme}] 4 pages laid out", pages == 4, str(pages)))

            page.click("#sidebarBtn")
            page.wait_for_selector("#outline a", timeout=10000)
            titles = page.eval_on_selector_all("#outline a", "els => els.map(e => e.textContent)")
            results.append(check(f"[{theme}] outline has headings", len(titles) >= 4 and "2. Results" in titles, json.dumps(titles[:6])))

            page.fill("#searchInput", "latency")
            page.wait_for_function("() => document.getElementById('searchCount').textContent.includes('of')", timeout=10000)
            page.wait_for_timeout(600)
            count = page.text_content("#searchCount")
            hl = page.eval_on_selector_all(".textLayer span.highlight", "els => els.length")
            results.append(check(f"[{theme}] search finds and highlights 'latency'", hl > 0 and "of" in count, f"{count}, {hl} highlighted spans"))
            page.press("#searchInput", "Enter")
            page.wait_for_timeout(300)
            results.append(check(f"[{theme}] Enter moves to the next match", page.text_content("#searchCount").startswith("2 of"), page.text_content("#searchCount")))

            # Dark mode pixel check on page 1: background dark, photo keeps its blue sky.
            info = page.evaluate("""() => {
              const c = document.querySelector('.page[data-page="1"] canvas');
              const ctx = c.getContext('2d');
              const px = (x, y) => Array.from(ctx.getImageData(Math.floor(x * c.width), Math.floor(y * c.height), 1, 1).data.slice(0, 3));
              return { bg: px(0.02, 0.02), dark: document.body.classList.contains('pdf-dark') };
            }""")
            # find the photo: scan the middle column of the canvas for a blue-ish pixel
            sky = page.evaluate("""() => {
              const c = document.querySelector('.page[data-page="1"] canvas');
              const ctx = c.getContext('2d');
              const d = ctx.getImageData(Math.floor(c.width * 0.3), 0, 1, c.height).data;
              for (let y = 0; y < c.height; y++) { const r = d[y*4], g = d[y*4+1], b = d[y*4+2]; if (b > 180 && r < 120 && g > 120) return [r, g, b]; }
              return null;
            }""")
            if theme == "dark":
                results.append(check("[dark] page background is dark", info["dark"] and max(info["bg"]) < 60, str(info["bg"])))
                results.append(check("[dark] photo keeps natural colors (blue sky found)", sky is not None, str(sky)))
            else:
                results.append(check("[light] page background is white", not info["dark"] and min(info["bg"]) > 240, str(info["bg"])))
                results.append(check("[light] photo visible (blue sky found)", sky is not None, str(sky)))

            # Outline navigation
            page.click("#outline a >> text=3. Next steps")
            page.wait_for_timeout(500)
            cur = page.input_value("#pageInput")
            results.append(check(f"[{theme}] outline click goes to page 3", cur == "3", cur))

            # Zoom
            page.select_option("#zoomSelect", "page-fit")
            page.wait_for_timeout(300)
            h = page.evaluate("document.querySelector('.page').offsetHeight")
            vh = page.evaluate("document.getElementById('viewer').clientHeight")
            results.append(check(f"[{theme}] fit page fits the height", h <= vh, f"page {h}px, view {vh}px"))
            page.select_option("#zoomSelect", "page-width")
            page.wait_for_timeout(300)

            # Hidden tab (R7 P3): page canvases are freed, then drawn again at the same spot when shown.
            before = page.evaluate("document.getElementById('viewer').scrollTop")
            page.evaluate("window.postMessage({ type: 'visibility', visible: false }, '*')")
            page.wait_for_timeout(400)
            hidden_canvases = page.eval_on_selector_all(".page canvas", "els => els.length")
            page.evaluate("window.postMessage({ type: 'visibility', visible: true }, '*')")
            page.wait_for_selector(".page .canvasWrap canvas", timeout=10000)
            page.wait_for_selector(".page .textLayer span.highlight", timeout=10000)
            after = page.evaluate("document.getElementById('viewer').scrollTop")
            shown_canvases = page.eval_on_selector_all(".page canvas", "els => els.length")
            results.append(check(f"[{theme}] hidden tab frees page canvases, showing it redraws in place",
                                 hidden_canvases == 0 and shown_canvases > 0 and abs(after - before) < 2,
                                 f"hidden {hidden_canvases}, shown {shown_canvases}, scroll {before} -> {after}"))

            csp = [e for e in errors if "Content Security Policy" in e or "Refused" in e]
            results.append(check(f"[{theme}] no CSP violations or page errors", not csp and not [e for e in errors if "Error" in e], "; ".join(errors)[:300]))

            if shot:
                page.click("#outline a >> text=1. Summary")
                page.fill("#searchInput", "latency")
                page.wait_for_function("() => document.getElementById('searchCount').textContent.includes('of')", timeout=10000)
                page.wait_for_timeout(800)
                page.evaluate("document.getElementById('viewer').scrollTop = 0")
                page.wait_for_timeout(800)
                page.screenshot(path=shot)
                print("screenshot", shot)
                if thumbs_shot:
                    page.click("#tab-thumbs")
                    page.fill("#searchInput", "")
                    page.press("#searchInput", "Escape")
                    page.select_option("#zoomSelect", "page-fit")
                    page.click("#thumbs .thumb >> nth=1")
                    page.wait_for_timeout(1200)
                    page.screenshot(path=thumbs_shot)
                    print("screenshot", thumbs_shot)
        finally:
            browser.close()
    finally:
        proc.terminate()
        proc.wait(timeout=5)
    return all(results)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shot")
    ap.add_argument("--light-shot")
    ap.add_argument("--thumbs-shot")
    a = ap.parse_args()
    with sync_playwright() as p:
        ok = run_theme(p, "dark", a.shot, a.thumbs_shot)
        ok = run_theme(p, "light", a.light_shot) and ok
    print("ALL PASS" if ok else "SOME FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
