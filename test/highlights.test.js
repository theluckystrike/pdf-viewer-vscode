'use strict';
// RK6: highlights (store, validation, Markdown export, host wiring), sepia pages and the selection maths.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const C = require('../media/core.js');
const { HighlightStore, sanitizeHighlight, sanitizeHighlights, highlightsToMarkdown, KEY, MAX_PER_FILE } = require('../src/highlights');
const { parseWebviewMessage } = require('../src/protocol');
const { buildHtml } = require('../src/html');

function memento() {
  const m = new Map();
  return { get: (k) => m.get(k), update: async (k, v) => { if (v === undefined) m.delete(k); else m.set(k, JSON.parse(JSON.stringify(v))); }, keys: () => [...m.keys()] };
}
const H = (o) => Object.assign({ id: 'a1', page: 2, rects: [[0.1, 0.2, 0.5, 0.02]], text: 'Hello', color: 'yellow', created: 1 }, o);

// ---------- selection maths ----------
test('core: selectionRects maps client rects to page fractions and merges a line', () => {
  const page = { left: 100, top: 50, width: 400, height: 800 };
  const rects = C.selectionRects([
    { left: 140, top: 130, width: 100, height: 16 },
    { left: 238, top: 131, width: 120, height: 15 }, // same line, touching: merged
    { left: 140, top: 160, width: 60, height: 16 }, // next line
    { left: 0, top: 0, width: 50, height: 10 }, // outside the page
    { left: 100, top: 50, width: 400, height: 700 }, // end-of-content filler
    { left: 150, top: 200, width: 0.5, height: 12 }, // empty
  ], page);
  assert.deepEqual(rects, [[0.1, 0.1, 0.545, 0.02], [0.1, 0.1375, 0.15, 0.02]]);
});

test('core: selectionRects clips to the page and copes with bad input', () => {
  assert.deepEqual(C.selectionRects([{ left: 450, top: 60, width: 100, height: 10 }], { left: 0, top: 0, width: 500, height: 1000 }), [[0.9, 0.06, 0.1, 0.01]]);
  assert.deepEqual(C.selectionRects(null, { left: 0, top: 0, width: 10, height: 10 }), []);
  assert.deepEqual(C.selectionRects([{ left: 1, top: 1, width: 5, height: 5 }], { left: 0, top: 0, width: 0, height: 10 }), []);
  const many = Array.from({ length: 500 }, (_, i) => ({ left: 0, top: i * 20, width: 10, height: 10 }));
  assert.equal(C.selectionRects(many, { left: 0, top: 0, width: 100, height: 20000 }).length, 200);
});

test('core: cleanSelectionText joins hyphenated lines and caps length', () => {
  assert.equal(C.cleanSelectionText('  Dark   mo-\n des keep\n\nphotos '), 'Dark modes keep photos');
  assert.equal(C.cleanSelectionText(null), '');
  const long = C.cleanSelectionText('x'.repeat(5000));
  assert.equal(long.length, 2000);
  assert.ok(long.endsWith('…'));
});

test('core: page modes and tints (dark wins over sepia)', () => {
  assert.equal(C.pageMode(true, true), 'dark');
  assert.equal(C.pageMode(false, true), 'sepia');
  assert.equal(C.pageMode(false, false), 'light');
  assert.equal(C.pageTint('light'), null);
  assert.deepEqual(C.pageTint('dark'), { filter: 'invert(0.88) hue-rotate(180deg)' });
  assert.deepEqual(C.pageTint('sepia'), { multiply: '#f4ecd8' });
  // multiply keeps black text black and turns white paper into the sepia color
  const hex = C.SEPIA_PAPER.slice(1).match(/../g).map((x) => parseInt(x, 16));
  assert.deepEqual([255, 255, 255].map((v, i) => Math.round(v * hex[i] / 255)), [244, 236, 216]);
  assert.deepEqual([0, 0, 0].map((v, i) => Math.round(v * hex[i] / 255)), [0, 0, 0]);
});

// ---------- validation ----------
test('highlights: sanitize keeps good entries and drops bad ones', () => {
  assert.deepEqual(sanitizeHighlight(H()), H());
  assert.equal(sanitizeHighlight(H({ color: 'red' })).color, 'yellow');
  assert.equal(sanitizeHighlight(H({ text: 'a\u0000b\nc' })).text, 'a b c');
  assert.equal(sanitizeHighlight(H({ text: 'x'.repeat(5000) })).text.length, 2000);
  assert.deepEqual(sanitizeHighlight(H({ rects: [[0.1, 0.2, 0.5, 0.02], [2, 0, 0.1, 0.1], [0, 0, 0, 0.1], 'x'] })).rects, [[0.1, 0.2, 0.5, 0.02]]);
  for (const bad of [null, 5, H({ id: '<img>' }), H({ id: '' }), H({ page: 0 }), H({ page: 1.5 }), H({ page: '2' }), H({ rects: [] }), H({ rects: [[5, 5, 5, 5]] }), H({ rects: 'x' })]) {
    assert.equal(sanitizeHighlight(bad), null, JSON.stringify(bad));
  }
});

test('highlights: list is de-duplicated, capped and sorted by page and position', () => {
  const list = sanitizeHighlights([H({ id: 'b', page: 3 }), H({ id: 'a', page: 1, rects: [[0, 0.5, 0.1, 0.1]] }), H({ id: 'c', page: 1, rects: [[0, 0.1, 0.1, 0.1]] }), H({ id: 'a', page: 9 })]);
  assert.deepEqual(list.map((h) => h.id), ['c', 'a', 'b']);
  assert.equal(sanitizeHighlights(Array.from({ length: MAX_PER_FILE + 50 }, (_, i) => H({ id: 'h' + i }))).length, MAX_PER_FILE);
  assert.deepEqual(sanitizeHighlights('nope'), []);
});

test('protocol: highlights messages are validated, copyHighlights carries nothing else', () => {
  assert.deepEqual(parseWebviewMessage({ type: 'highlights', items: [H(), { id: 'bad id' }] }), { type: 'highlights', items: [H()] });
  assert.equal(parseWebviewMessage({ type: 'highlights', items: 'x' }), null);
  assert.equal(parseWebviewMessage({ type: 'highlights', items: new Array(6000).fill(H()) }), null);
  assert.deepEqual(parseWebviewMessage({ type: 'copyHighlights', x: 1 }), { type: 'copyHighlights' });
});

// ---------- store ----------
test('highlights: store keeps a list per file, empties delete the file, oldest files go first', async () => {
  const m = memento();
  const s = new HighlightStore(m, 2);
  await s.set('file:///a.pdf', [H()]);
  assert.deepEqual(s.get('file:///a.pdf'), [H()]);
  assert.deepEqual(s.get('file:///none.pdf'), []);
  await s.set('file:///a.pdf', []);
  assert.deepEqual(Object.keys(m.get(KEY)), []);
  await s.set('file:///1.pdf', [H()]);
  await new Promise((r) => setTimeout(r, 2));
  await s.set('file:///2.pdf', [H()]);
  await new Promise((r) => setTimeout(r, 2));
  await s.set('file:///3.pdf', [H(), H({ id: 'z' })]);
  assert.deepEqual(Object.keys(m.get(KEY)).sort(), ['file:///2.pdf', 'file:///3.pdf']);
  assert.equal(s.count(), 3);
  await s.clear();
  assert.equal(m.get(KEY), undefined);
  // a corrupt stored value reads as no highlights
  assert.deepEqual(new HighlightStore({ get: () => ({ 'file:///x.pdf': { items: [{ evil: 1 }] } }), update: async () => {} }).get('file:///x.pdf'), []);
});

// ---------- Markdown ----------
test('highlights: Markdown export quotes each highlight and links to its page', () => {
  const md = highlightsToMarkdown({ fileName: 'my paper.pdf', relPath: 'docs/my paper.pdf', fileUri: 'file:///ws/docs/my%20paper.pdf' },
    [H({ id: 'b', page: 12, text: 'Second' }), H({ id: 'a', page: 3, text: 'First  one' })]);
  assert.equal(md, '## Highlights in my paper.pdf\n\n- "First one" ([page 3](/docs/my%20paper.pdf#page=3))\n- "Second" ([page 12](/docs/my%20paper.pdf#page=12))\n');
  const outside = highlightsToMarkdown({ fileName: 'b.pdf', relPath: null, fileUri: 'file:///elsewhere/b.pdf' }, [H({ text: '' })]);
  assert.match(outside, /- "\(no text\)" \(\[page 2\]\(file:\/\/\/elsewhere\/b\.pdf#page=2\)\)/);
  assert.match(highlightsToMarkdown({ fileName: 'c.pdf', relPath: 'c.pdf' }, []), /No highlights yet/);
});

// ---------- webview HTML and package ----------
test('html: sepia button, Highlights tab and color popup, CSP unchanged', () => {
  const uris = { core: 'https://r/core.js', viewer: 'https://r/viewer.js', css: 'https://r/v.css', pdfjs: 'https://r/pdf.min.mjs', worker: 'https://r/w.mjs', cmaps: 'https://r/c/', fonts: 'https://r/f/', wasm: 'https://r/w/' };
  const html = buildHtml(uris, 'https://r', 'N1');
  for (const id of ['sepiaBtn', 'tab-hls', 'hls', 'hlList', 'hlCopy', 'hlPop']) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.equal((html.match(/class="hlSwatch"/g) || []).length, 4);
  const csp = /content="([^"]+)"/.exec(html)[1];
  assert.doesNotMatch(csp, /'unsafe-inline'|'unsafe-eval'|https?:\/\/(?!r)/);
  assert.match(csp, /connect-src https:\/\/r;/);
});

test('package: new commands, setting and listing text', () => {
  const pkg = require('../package.json');
  const ids = pkg.contributes.commands.map((c) => c.command);
  for (const id of ['pdfViewer.toggleSepia', 'pdfViewer.highlightSelection', 'pdfViewer.showHighlights', 'pdfViewer.copyHighlights']) {
    assert.ok(ids.includes(id), id);
    assert.ok(pkg.contributes.menus.commandPalette.some((m) => m.command === id && /pdfViewer\.preview/.test(m.when)), id);
  }
  const s = pkg.contributes.configuration.properties['pdfViewer.lightPages'];
  assert.deepEqual(s.enum, ['white', 'sepia']);
  assert.equal(s.default, 'white');
  assert.equal(pkg.displayName, 'PDF Viewer & PDF Reader');
  assert.ok(pkg.keywords.length <= 30 && new Set(pkg.keywords).size === pkg.keywords.length);
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  assert.match(readme.split('\n')[0], /^# PDF Viewer & PDF Reader$/);
});
