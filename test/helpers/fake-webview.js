'use strict';
// A stand-in for the webview's runPageOp (media/viewer.js) that uses the same pdf.js API in Node: it opens the PDF,
// pre-checks extra files and answers a 'pageOp' job with the bytes extractPages() wrote. Used by the Pro tests.
const fs = require('fs');
const path = require('path');

globalThis.DOMMatrix ??= class { constructor() { Object.assign(this, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }); } };
globalThis.Path2D ??= class {};
globalThis.ImageData ??= class {};

const PDFJS = path.join(__dirname, '..', '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs');
const available = fs.existsSync(PDFJS);
let libP = null;
function lib() {
  if (!libP) {
    libP = import(PDFJS).then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = path.join(path.dirname(PDFJS), 'pdf.worker.mjs');
      return pdfjs;
    });
  }
  return libP;
}

async function open(bytes, password) {
  const pdfjs = await lib();
  return pdfjs.getDocument({ data: new Uint8Array(bytes), password, isEvalSupported: false, verbosity: 0 }).promise;
}

async function pageTexts(bytes, password) {
  const d = await open(bytes, password);
  const out = [];
  for (let i = 1; i <= d.numPages; i++) {
    const t = await (await d.getPage(i)).getTextContent();
    out.push(t.items.map((x) => x.str).join(' ').replace(/\s+/g, ' ').trim());
  }
  await d.destroy();
  return out;
}

// Same steps as runPageOp in media/viewer.js.
async function runPageOp(doc, m) {
  try {
    const extras = (m.extras || []).map((b) => new Uint8Array(b));
    const extraPages = [];
    for (let i = 0; i < extras.length; i++) {
      const pdfjs = await lib();
      let needsPassword = false;
      const task = pdfjs.getDocument({ data: extras[i].slice(), isEvalSupported: false, verbosity: 0 });
      task.onPassword = () => { needsPassword = true; task.destroy(); };
      try { extraPages.push((await task.promise).numPages); } catch (e) {
        throw new Error('file ' + (i + 1) + ' of the merge ' + (needsPassword ? 'needs a password' : 'is not a readable PDF'));
      } finally { task.destroy().catch(() => {}); }
    }
    const results = [];
    for (const plan of m.plans) {
      const infos = plan.map((p) => {
        const o = { document: p.src === -1 ? null : extras[p.src] };
        if (Array.isArray(p.includePages)) o.includePages = p.includePages;
        if (Array.isArray(p.excludePages)) o.excludePages = p.excludePages;
        return o;
      });
      const out = await doc.extractPages(infos);
      if (!out || !out.byteLength) throw new Error('pdf.js could not write the new PDF');
      results.push(out);
    }
    return { type: 'pageOpResult', id: m.id, results, extraPages };
  } catch (e) {
    return { type: 'pageOpResult', id: m.id, error: String((e && e.message) || e) };
  }
}

module.exports = { available, PDFJS, open, pageTexts, runPageOp, lib };
