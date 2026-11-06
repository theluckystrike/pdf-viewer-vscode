'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../media/core');

const OPS = { save: 10, restore: 11, transform: 12, paintFormXObjectBegin: 74, paintFormXObjectEnd: 75, paintImageMaskXObject: 83, paintImageXObject: 85, paintInlineImageXObject: 86, paintImageXObjectRepeat: 88 };
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('imageRects: image under nested transforms, restore pops state', () => {
  const fn = [OPS.save, OPS.transform, OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore, OPS.paintImageXObject, OPS.restore];
  const args = [null, [2, 0, 0, 2, 10, 20], null, [100, 0, 0, 50, 5, 5], ['img1', 10, 10], null, ['img2', 4, 4], null];
  const r = C.imageRects(fn, args, OPS);
  assert.equal(r.length, 2);
  assert.deepEqual(r[0], { x: 20, y: 30, w: 200, h: 100 });
  // second image: only the outer transform applies (unit square scaled by 2)
  assert.deepEqual(r[1], { x: 10, y: 20, w: 2, h: 2 });
});

test('imageRects: flipped matrix (negative d) gives a positive box', () => {
  const r = C.imageRects([OPS.transform, OPS.paintImageXObject], [[300, 0, 0, -100, 50, 400], ['x', 1, 1]], OPS);
  assert.deepEqual(r, [{ x: 50, y: 300, w: 300, h: 100 }]);
});

test('imageRects: form XObject matrix applies until FormXObjectEnd', () => {
  const fn = [OPS.paintFormXObjectBegin, OPS.transform, OPS.paintImageXObject, OPS.paintFormXObjectEnd, OPS.transform, OPS.paintInlineImageXObject];
  const args = [[[1, 0, 0, 1, 100, 100], [0, 0, 10, 10]], [10, 0, 0, 10, 0, 0], ['a'], null, [5, 0, 0, 5, 0, 0], [{}]];
  const r = C.imageRects(fn, args, OPS);
  assert.deepEqual(r[0], { x: 100, y: 100, w: 10, h: 10 });
  assert.deepEqual(r[1], { x: 0, y: 0, w: 5, h: 5 });
});

test('imageRects: image masks are not kept (they follow text colors)', () => {
  const r = C.imageRects([OPS.transform, OPS.paintImageMaskXObject], [[10, 0, 0, 10, 0, 0], [{}]], OPS);
  assert.deepEqual(r, []);
});

test('imageRects: repeated image expands to one rect per position, with a cap', () => {
  const r = C.imageRects([OPS.paintImageXObjectRepeat], [['img', 10, 20, [0, 0, 50, 60]]], OPS);
  assert.deepEqual(r, [{ x: 0, y: 0, w: 10, h: 20 }, { x: 50, y: 60, w: 10, h: 20 }]);
  const many = C.imageRects(new Array(1000).fill(OPS.paintImageXObject), new Array(1000).fill(['i']), OPS, 100);
  assert.equal(many.length, 100);
});

test('imageRects: unbalanced restore and malformed args do not throw', () => {
  const r = C.imageRects([OPS.restore, OPS.transform, OPS.transform, OPS.paintImageXObject], [null, null, ['x'], ['i']], OPS);
  assert.deepEqual(r, [{ x: 0, y: 0, w: 1, h: 1 }]);
});

test('toCanvasRects: maps with viewport transform, rounds and clips', () => {
  // viewport transform for a 600x800 page at scale 1: flips y
  const tf = [1, 0, 0, -1, 0, 800];
  const r = C.toCanvasRects([{ x: 10.4, y: 100, w: 200, h: 50.6 }, { x: 590, y: 0, w: 100, h: 10 }, { x: 0, y: 2000, w: 5, h: 5 }], tf, 600, 800);
  assert.deepEqual(r[0], { x: 10, y: 649, w: 200, h: 51 });
  assert.deepEqual(r[1], { x: 590, y: 790, w: 10, h: 10 });
  assert.equal(r.length, 2);
});

test('computeScale: fit width, fit page, numbers, clamping', () => {
  const page = { width: 600, height: 800 };
  near(C.computeScale('page-width', page, { width: 1224, height: 500 }), 2);
  near(C.computeScale('page-fit', page, { width: 1224, height: 824 }), 1);
  assert.equal(C.computeScale(1.5, page, { width: 10, height: 10 }), 1.5);
  assert.equal(C.computeScale(100, page, { width: 10, height: 10 }), C.MAX_SCALE);
  assert.equal(C.computeScale('page-width', null, { width: 10, height: 10 }), 1);
});

test('nextZoom and parseZoom', () => {
  assert.equal(C.nextZoom(1, 1), 1.1);
  assert.equal(C.nextZoom(1, -1), 0.9);
  assert.equal(C.nextZoom(1.05, 1), 1.1);
  assert.equal(C.nextZoom(5, 1), 6.25);
  assert.ok(C.nextZoom(0.1, -1) >= C.MIN_SCALE);
  assert.equal(C.parseZoom('125%'), 1.25);
  assert.equal(C.parseZoom('150'), 1.5);
  assert.equal(C.parseZoom('2x'), 2);
  assert.equal(C.parseZoom('Fit width'), 'page-width');
  assert.equal(C.parseZoom('page-fit'), 'page-fit');
  assert.equal(C.parseZoom('abc'), null);
  assert.equal(C.parseZoom('99999'), C.MAX_SCALE);
});

const items = (...pairs) => pairs.map(([str, hasEOL]) => ({ str, hasEOL: !!hasEOL }));

test('findInPage: case-insensitive, across items, EOL becomes a space', () => {
  const it = items(['The Edge cache cut ', false], ['median lat', false], ['ency today', true], ['latency again', false]);
  const m = C.findInPage(it, 'LATENCY');
  assert.equal(m.length, 2);
  assert.deepEqual(m[0].parts, [{ item: 1, from: 7, to: 10 }, { item: 2, from: 0, to: 4 }]);
  assert.deepEqual(m[1].parts, [{ item: 3, from: 0, to: 7 }]);
  // words on two lines match with a space in the query
  assert.equal(C.findInPage(it, 'today latency').length, 1);
  assert.equal(C.findInPage(it, 'Latency', { caseSensitive: true }).length, 0);
});

test('findInPage: whole word, empty query, max matches', () => {
  const it = items(['cat concat cat.', false]);
  assert.equal(C.findInPage(it, 'cat').length, 3);
  assert.equal(C.findInPage(it, 'cat', { wholeWord: true }).length, 2);
  assert.deepEqual(C.findInPage(it, '   '), []);
  assert.equal(C.findInPage(items(['aaaaaaaa', false]), 'a', { maxMatches: 3 }).length, 3);
});

test('findInPage: characters whose lower case changes length keep offsets aligned', () => {
  const it = items(['İstanbul latency', false]);
  const m = C.findInPage(it, 'latency');
  assert.deepEqual(m[0].parts, [{ item: 0, from: 9, to: 16 }]);
});

test('segments: splits text into plain and highlighted parts', () => {
  assert.deepEqual(C.segments('hello world', [{ from: 6, to: 11, cls: 'highlight selected' }]), [
    { text: 'hello ', cls: null },
    { text: 'world', cls: 'highlight selected' },
  ]);
  // overlapping ranges are merged left to right without duplicating text
  const s = C.segments('abcdef', [{ from: 1, to: 4 }, { from: 2, to: 5 }]);
  assert.equal(s.map((x) => x.text).join(''), 'abcdef');
});

test('flattenOutline: ids, depth, titles kept as text, limits', () => {
  const tree = C.flattenOutline([
    { title: '<img src=x onerror=alert(1)>', dest: 'd1', items: [{ title: '  Child\n  one ', dest: [0], items: [] }] },
    { title: '', url: 'https://example.com', items: [] },
  ]);
  assert.equal(tree[0].title, '<img src=x onerror=alert(1)>'); // rendered with textContent in the webview
  assert.equal(tree[0].children[0].title, 'Child one');
  assert.equal(tree[0].children[0].id, '0.0');
  assert.equal(tree[0].children[0].depth, 1);
  assert.equal(tree[1].title, '(untitled)');
  assert.equal(tree[1].url, 'https://example.com');
  const long = C.flattenOutline([{ title: 'x'.repeat(1000), items: [] }]);
  assert.equal(long[0].title.length, 301);
  const big = C.flattenOutline(new Array(100).fill({ title: 't', items: [] }), 10);
  assert.equal(big.length, 10);
});

test('resolveDest: named, explicit with ref, integer page, fit modes', async () => {
  const named = { chap2: [{ num: 7, gen: 0 }, { name: 'XYZ' }, 0, 700, null] };
  const getDest = async (n) => named[n] || null;
  const getIdx = async (ref) => (ref.num === 7 ? 4 : 0);
  assert.deepEqual(await C.resolveDest('chap2', getDest, getIdx), { pageIndex: 4, top: 700 });
  assert.deepEqual(await C.resolveDest([2, { name: 'Fit' }], getDest, getIdx), { pageIndex: 2, top: null });
  assert.deepEqual(await C.resolveDest([{ num: 7 }, { name: 'FitH' }, 500], getDest, getIdx), { pageIndex: 4, top: 500 });
  assert.equal(await C.resolveDest('missing', getDest, getIdx), null);
  assert.equal(await C.resolveDest(['bad'], getDest, getIdx), null);
});

test('isSafeExternalUrl allows http, https, mailto only', () => {
  assert.ok(C.isSafeExternalUrl('https://example.com/a'));
  assert.ok(C.isSafeExternalUrl('mailto:a@b.c'));
  assert.ok(!C.isSafeExternalUrl('javascript:alert(1)'));
  assert.ok(!C.isSafeExternalUrl('file:///etc/passwd'));
  assert.ok(!C.isSafeExternalUrl('command:workbench.action.terminal.new'));
  assert.ok(!C.isSafeExternalUrl('not a url'));
  assert.ok(!C.isSafeExternalUrl('https://x/' + 'a'.repeat(3000)));
});

test('isDark follows the theme in auto mode', () => {
  assert.equal(C.isDark('auto', 'vscode-dark'), true);
  assert.equal(C.isDark('auto', 'vscode-high-contrast'), true);
  assert.equal(C.isDark('auto', 'vscode-high-contrast-light'), false);
  assert.equal(C.isDark('auto', 'vscode-light'), false);
  assert.equal(C.isDark('on', 'vscode-light'), true);
  assert.equal(C.isDark('off', 'vscode-dark'), false);
});

test('visiblePages and currentPage on a long document', () => {
  const n = 10000;
  const tops = Array.from({ length: n }, (_, i) => 10 + i * 1010);
  const heights = new Array(n).fill(1000);
  assert.deepEqual(C.visiblePages(tops, heights, 0, 800, 0), [0]);
  assert.deepEqual(C.visiblePages(tops, heights, 5050, 800, 0), [4, 5]);
  const start = Date.now();
  for (let k = 0; k < 2000; k++) C.visiblePages(tops, heights, k * 4000, 800, 600);
  assert.ok(Date.now() - start < 500, 'binary search keeps scrolling cheap');
  assert.equal(C.currentPage(tops, heights, 0, 800), 1);
  assert.equal(C.currentPage(tops, heights, 1010 * 41, 800), 42);
  assert.equal(C.currentPage([], [], 0, 800), 1);
});

test('toBytes accepts every shape the host message can take', () => {
  const want = [37, 80, 68, 70];
  assert.deepEqual(Array.from(C.toBytes(new Uint8Array(want))), want);
  assert.deepEqual(Array.from(C.toBytes(new Uint8Array(want).buffer)), want);
  assert.deepEqual(Array.from(C.toBytes(JSON.parse(JSON.stringify(Buffer.from(want))))), want);
  assert.deepEqual(Array.from(C.toBytes(new DataView(new Uint8Array([0, ...want]).buffer, 1))), want);
  assert.deepEqual(Array.from(C.toBytes({ 0: 37, 1: 80, 2: 68, 3: 70 })), want);
  assert.deepEqual(Array.from(C.toBytes(want)), want);
  assert.equal(C.toBytes(null).length, 0);
  assert.equal(C.toBytes({ foo: 1 }).length, 0);
});

test('visibilityAction: free canvases when hidden, redraw when shown, nothing otherwise (R7 P3)', () => {
  assert.equal(C.visibilityAction(true, false), 'free');
  assert.equal(C.visibilityAction(false, true), 'render');
  assert.equal(C.visibilityAction(true, true), null);
  assert.equal(C.visibilityAction(false, false), null);
});
