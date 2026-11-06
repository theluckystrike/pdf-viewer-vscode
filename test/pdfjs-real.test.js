'use strict';
// Runs the core helpers against real pdf.js output for test/fixtures/sample.pdf (made by scripts/make-sample.py).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const C = require('../media/core');

// pdf.js wants these browser globals at import time. We never render in Node, so stubs are enough.
globalThis.DOMMatrix ??= class { constructor() { Object.assign(this, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }); } };
globalThis.Path2D ??= class {};
globalThis.ImageData ??= class {};

const FIX = path.join(__dirname, 'fixtures', 'sample.pdf');
const PDFJS = path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs');
const skip = !fs.existsSync(PDFJS) ? 'run npm install first (pdfjs-dist is a dev dependency)' : false;

let docPromise;
async function load() {
  if (!docPromise) {
    docPromise = (async () => {
      const origWarn = console.log;
      const pdfjs = await import(PDFJS);
      pdfjs.GlobalWorkerOptions.workerSrc = path.join(path.dirname(PDFJS), 'pdf.worker.mjs');
      const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(FIX)), isEvalSupported: false, verbosity: 0 }).promise;
      console.log = origWarn;
      return { pdfjs, doc };
    })();
  }
  return docPromise;
}

test('real PDF: the photo on page 1 is found as one image rect inside the page', { skip }, async () => {
  const { pdfjs, doc } = await load();
  const page = await doc.getPage(1);
  const ops = await page.getOperatorList();
  const rects = C.imageRects(ops.fnArray, ops.argsArray, pdfjs.OPS);
  assert.equal(rects.length, 1);
  const r = rects[0];
  const [, , pw, ph] = page.view;
  assert.ok(r.x > 0 && r.x + r.w < pw && r.y > 0 && r.y + r.h < ph, JSON.stringify(r));
  // 640x300 source image scaled to the text width: aspect ratio must survive the transforms
  assert.ok(Math.abs(r.w / r.h - 640 / 300) < 0.02, `ratio ${r.w / r.h}`);
  const vp = page.getViewport({ scale: 2 });
  const px = C.toCanvasRects(rects, vp.transform, Math.round(vp.width), Math.round(vp.height));
  assert.equal(px.length, 1);
  assert.ok(Math.abs(px[0].w - r.w * 2) <= 1);
});

test('real PDF: page 3 has no raster images', { skip }, async () => {
  const { pdfjs, doc } = await load();
  const ops = await (await doc.getPage(3)).getOperatorList();
  assert.deepEqual(C.imageRects(ops.fnArray, ops.argsArray, pdfjs.OPS), []);
});

test('real PDF: search counts every "latency" across pages', { skip }, async () => {
  const { doc } = await load();
  let total = 0;
  const perPage = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    const its = tc.items.filter((x) => typeof x.str === 'string');
    const m = C.findInPage(its, 'latency');
    perPage.push(m.length);
    total += m.length;
    for (const hit of m) {
      const text = hit.parts.map((p) => its[p.item].str.slice(p.from, p.to)).join('');
      assert.equal(text.toLowerCase().replace(/\s+/g, ''), 'latency');
    }
  }
  // 3 per paragraph: page 1 (1 paragraph), page 2 (2 paragraphs + "Latency by region"),
  // page 3 (1 paragraph + "p95 latency"), page 4 (3 paragraphs)
  assert.deepEqual(perPage, [3, 7, 4, 9]);
  assert.equal(total, 23);
});

test('real PDF: outline titles and destinations resolve to the right pages', { skip }, async () => {
  const { doc } = await load();
  const tree = C.flattenOutline(await doc.getOutline());
  const flat = [];
  (function walk(n) { for (const x of n) { flat.push(x); walk(x.children); } })(tree);
  assert.deepEqual(flat.map((x) => x.title), ['Field Report: Edge Cache Rollout', '1. Summary', '2. Results', '2.1 Latency by region', '3. Next steps', 'Appendix A. Method']);
  const pages = [];
  for (const x of flat) {
    const t = await C.resolveDest(x.dest, (n) => doc.getDestination(n), (r) => doc.getPageIndex(r));
    pages.push(t.pageIndex);
    assert.equal(typeof t.top, 'number');
  }
  assert.deepEqual(pages, [0, 0, 1, 1, 2, 3]);
});

test.after(async () => {
  if (docPromise) { const { doc } = await docPromise; await doc.destroy(); }
});
