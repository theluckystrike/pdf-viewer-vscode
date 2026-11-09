'use strict';
// Zovo Pro in PDF Viewer: page lists, extract/delete/split/merge plans run through the real pdf.js extractPages in
// Node, the all-highlights Markdown, the free-try rules and the host flows with a fake vscode. No network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const P = require('../src/pages');
const { parseWebviewMessage } = require('../src/protocol');
const { allHighlightsToMarkdown, HighlightStore } = require('../src/highlights');
const W = require('./helpers/fake-webview');

const FIX = (n) => path.join(__dirname, 'fixtures', n);
const SAMPLE = fs.readFileSync(FIX('sample.pdf')); // 4 pages
const QUAKE = fs.readFileSync(FIX('earthquakes-october-2026.pdf')); // 3 pages
const skip = W.available ? false : 'run npm install first (pdfjs-dist is a dev dependency)';

// ---------- page lists ----------
test('parsePageList: numbers, ranges, open ends, last, separators, order kept', () => {
  assert.deepEqual(P.parsePageList('1-3, 7, 10-', 12).segments, [{ from: 1, to: 3 }, { from: 7, to: 7 }, { from: 10, to: 12 }]);
  assert.deepEqual(P.parsePageList('-2;last', 5).segments, [{ from: 1, to: 2 }, { from: 5, to: 5 }]);
  assert.deepEqual(P.parsePageList(' 3   1 ', 5).segments, [{ from: 3, to: 3 }, { from: 1, to: 1 }]);
  assert.deepEqual(P.parsePageList('2 – 4', 5).segments, [{ from: 2, to: 4 }]);
  assert.deepEqual(P.parsePageList('4-end', 5).segments, [{ from: 4, to: 5 }]);
});

test('parsePageList: clear errors for bad input', () => {
  assert.match(P.parsePageList('', 5).error, /Type page numbers/);
  assert.match(P.parsePageList('0', 5).error, /start at 1/);
  assert.match(P.parsePageList('6', 5).error, /has 5 pages/);
  assert.match(P.parsePageList('4-2', 5).error, /backwards/);
  assert.match(P.parsePageList('a', 5).error, /not a page/);
  assert.match(P.parsePageList('-', 5).error, /needs a page/);
  assert.match(P.parsePageList('1.5', 5).error, /not a page/);
  assert.match(P.parsePageList('1', 0).error, /no pages/);
  assert.match(P.parsePageList(Array(600).fill('1').join(','), 5).error, /Too many/);
});

test('plans: extract keeps the typed order, delete refuses to empty the file, split parts and names', () => {
  assert.deepEqual(P.extractPlan([{ from: 1, to: 2 }, { from: 4, to: 4 }]), [{ src: -1, includePages: [[0, 1], 3] }]);
  assert.deepEqual(P.extractPlan([{ from: 3, to: 3 }, { from: 1, to: 2 }]), [{ src: -1, includePages: [2] }, { src: -1, includePages: [[0, 1]] }]);
  assert.match(P.deletePlan([{ from: 1, to: 4 }], 4).error, /every page/);
  const d = P.deletePlan([{ from: 2, to: 2 }, { from: 2, to: 3 }], 4);
  assert.deepEqual(d, { plan: [{ src: -1, excludePages: [1, [1, 2]] }], left: 2, removed: 2 });
  assert.deepEqual(P.splitParts('every', 10, 4).parts, [{ from: 1, to: 4 }, { from: 5, to: 8 }, { from: 9, to: 10 }]);
  assert.equal(P.splitParts('each', 3).parts.length, 3);
  assert.match(P.splitParts('every', 3, 3).error, /one piece/);
  assert.match(P.splitParts('every', 3, 0).error, /whole number/);
  assert.match(P.splitParts('every', 5000, 1).error, /limit/);
  assert.deepEqual(P.splitNames('Report.PDF', [{ from: 1, to: 4 }, { from: 5, to: 5 }]), ['Report-part-01-p1-4.pdf', 'Report-part-02-p5.pdf']);
  assert.equal(P.rangeLabel([{ from: 1, to: 3 }, { from: 7, to: 7 }]), '1-3_7');
  assert.ok(P.rangeLabel(Array.from({ length: 30 }, (_, i) => ({ from: i * 2 + 1, to: i * 2 + 1 }))).endsWith('_etc'));
  assert.match(P.mergePlan([-1]).error, /at least one/);
  assert.deepEqual(P.mergePlan([1, -1, 0]).plan, [{ src: 1 }, { src: -1 }, { src: 0 }]);
});

test('validPlan: only known keys and pages inside the file', () => {
  assert.equal(P.validPlan([{ src: -1, includePages: [[0, 3]] }], 4, 0), true);
  assert.equal(P.validPlan([{ src: -1, includePages: [[0, 4]] }], 4, 0), false);
  assert.equal(P.validPlan([{ src: 0 }], 4, 0), false);
  assert.equal(P.validPlan([{ src: -1, document: 'x' }], 4, 0), false);
  assert.equal(P.validPlan([{ src: -1, excludePages: [[2, 1]] }], 4, 0), false);
  assert.equal(P.validPlan([], 4, 0), false);
});

// ---------- protocol ----------
test('protocol: pageOpResult takes bytes only, with a job id', () => {
  const r = parseWebviewMessage({ type: 'pageOpResult', id: 3, results: [new Uint8Array([1, 2]), new Uint8Array(4).buffer], extraPages: [3] });
  assert.equal(r.results.length, 2);
  assert.ok(r.results.every((b) => b instanceof Uint8Array));
  assert.deepEqual(r.extraPages, [3]);
  assert.deepEqual(parseWebviewMessage({ type: 'pageOpResult', id: 3, error: 'x'.repeat(900) }).error.length, 300);
  for (const bad of [{ type: 'pageOpResult', id: 0, results: [new Uint8Array(1)] }, { type: 'pageOpResult', id: 1, results: ['abc'] },
    { type: 'pageOpResult', id: 1, results: [] }, { type: 'pageOpResult', id: 1.5, results: [new Uint8Array(1)] }]) {
    assert.equal(parseWebviewMessage(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual(parseWebviewMessage({ type: 'pageTools', x: 1 }), { type: 'pageTools' });
  assert.deepEqual(parseWebviewMessage({ type: 'exportAllHighlights' }), { type: 'exportAllHighlights' });
});

// ---------- real pdf.js ----------
test('real pdf.js: extract in a new order, delete, split and merge give the right pages', { skip }, async () => {
  const doc = await W.open(SAMPLE);
  const src = await W.pageTexts(SAMPLE);
  const run = async (plans, extras) => W.runPageOp(doc, { id: 1, plans, extras });

  let r = await run([P.extractPlan(P.parsePageList('3, 1-2', 4).segments)]);
  assert.deepEqual(await W.pageTexts(r.results[0]), [src[2], src[0], src[1]]);

  r = await run([P.deletePlan(P.parsePageList('2', 4).segments, 4).plan]);
  assert.deepEqual(await W.pageTexts(r.results[0]), [src[0], src[2], src[3]]);

  const parts = P.splitParts('every', 4, 3).parts;
  r = await run(parts.map((p) => P.extractPlan([p])));
  assert.equal(r.results.length, 2);
  assert.deepEqual(await W.pageTexts(r.results[0]), src.slice(0, 3));
  assert.deepEqual(await W.pageTexts(r.results[1]), src.slice(3));

  const q = await W.pageTexts(QUAKE);
  r = await run([P.mergePlan([0, -1]).plan], [new Uint8Array(QUAKE)]);
  assert.deepEqual(r.extraPages, [3]);
  assert.deepEqual(await W.pageTexts(r.results[0]), [...q, ...src]);
  await doc.destroy();
});

test('real pdf.js: a broken or password-protected merge file gets a clear message, not a crash', { skip }, async () => {
  const doc = await W.open(SAMPLE);
  let r = await W.runPageOp(doc, { id: 2, plans: [[{ src: -1 }, { src: 0 }]], extras: [fs.readFileSync(FIX('broken.pdf'))] });
  assert.match(r.error, /file 1 of the merge is not a readable PDF/);
  r = await W.runPageOp(doc, { id: 3, plans: [[{ src: -1 }, { src: 0 }]], extras: [fs.readFileSync(FIX('user-password.pdf'))] });
  assert.match(r.error, /needs a password/);
  await doc.destroy();
});

test('real pdf.js: pages of an encrypted PDF stay readable and keep the protection', { skip }, async () => {
  const owner = fs.readFileSync(FIX('owner-password.pdf'));
  let doc = await W.open(owner);
  let r = await W.runPageOp(doc, { id: 4, plans: [P.extractPlan([{ from: 2, to: 3 }])] });
  assert.equal((await W.pageTexts(r.results[0])).length, 2);
  await doc.destroy();
  doc = await W.open(fs.readFileSync(FIX('user-password.pdf')), 'user');
  r = await W.runPageOp(doc, { id: 5, plans: [P.extractPlan([{ from: 1, to: 1 }])] });
  await assert.rejects(W.open(r.results[0]), /password/i);
  assert.equal((await W.pageTexts(r.results[0], 'user')).length, 1);
  await doc.destroy();
});

// ---------- all highlights ----------
test('allHighlightsToMarkdown: grouped by path, color and page link on each line, escapes titles', () => {
  const h = (id, page, text, color) => ({ id, page, rects: [[0.1, 0.2 + page / 100, 0.1, 0.01]], text, color: color || 'yellow' });
  const md = allHighlightsToMarkdown([
    { fileName: 'z.pdf', relPath: 'papers/z_1.pdf', fileUri: 'file:///w/papers/z_1.pdf', items: [h('b', 5, 'second'), h('a', 1, 'first  line', 'green')] },
    { fileName: 'a.pdf', relPath: null, fileUri: 'file:///tmp/a.pdf', items: [h('c', 2, '')] },
    { fileName: 'empty.pdf', relPath: 'e.pdf', fileUri: 'file:///w/e.pdf', items: [] },
  ], { date: '2026-11-09' });
  assert.match(md, /^# PDF highlights\n\n3 highlights in 2 PDFs on 2026-11-09\./);
  assert.ok(md.indexOf('## a.pdf') < md.indexOf('## papers/z\\_1.pdf'));
  assert.match(md, /- "first line" \(\[page 1\]\(\/papers\/z_1\.pdf#page=1\), green\)\n- "second" \(\[page 5\]\(\/papers\/z_1\.pdf#page=5\), yellow\)/);
  assert.match(md, /- "\(no text\)" \(\[page 2\]\(file:\/\/\/tmp\/a\.pdf#page=2\), yellow\)/);
  assert.doesNotMatch(md, /empty\.pdf/);
});

test('HighlightStore.entries lists every file with highlights, newest first', async () => {
  const m = new Map();
  const mem = { get: (k) => m.get(k), update: async (k, v) => { m.set(k, JSON.parse(JSON.stringify(v))); } };
  const s = new HighlightStore(mem);
  const one = [{ id: 'a', page: 1, rects: [[0.1, 0.1, 0.1, 0.1]], text: 'x', color: 'blue' }];
  await s.set('file:///a.pdf', one);
  await new Promise((r) => setTimeout(r, 5));
  await s.set('file:///b.pdf', one);
  await s.set('file:///c.pdf', []);
  assert.deepEqual(s.entries().map((e) => e.key), ['file:///b.pdf', 'file:///a.pdf']);
});

// ---------- host flows with a fake vscode ----------
function fakeVscode(opts) {
  const o = opts || {};
  const log = { info: [], warn: [], modal: [], status: [], picks: [], inputs: [], saves: [], opens: [], written: new Map(), external: [], commands: [] };
  const answers = { input: o.input || [], pick: o.pick || [], save: o.save || [], open: o.open || [], info: o.info || [], warn: o.warn || [] };
  class Uri {
    constructor(scheme, p, fragment) { this.scheme = scheme; this.path = p; this.fsPath = p; this.fragment = fragment || ''; }
    static file(p) { return new Uri('file', p); }
    static parse(s) { const u = new URL(s); return new Uri(u.protocol.slice(0, -1), decodeURIComponent(u.pathname), u.hash.slice(1)); }
    static joinPath(u, ...parts) { return new Uri(u.scheme, path.posix.join(u.path, ...parts)); }
    with(c) { return new Uri(c.scheme ?? this.scheme, c.path ?? this.path, c.fragment ?? this.fragment); }
    toString() { return this.scheme + '://' + this.path + (this.fragment ? '#' + this.fragment : ''); }
  }
  const files = new Map(Object.entries(o.files || {}));
  const settings = Object.assign({ showProFeatures: true }, o.settings || {});
  const state = new Map();
  const vscode = {
    Uri,
    ProgressLocation: { Notification: 15 },
    window: {
      showInformationMessage: async (msg, ...rest) => {
        if (rest[0] && typeof rest[0] === 'object' && rest[0].modal) { log.modal.push({ msg, detail: rest[0].detail, buttons: rest.slice(1) }); return answers.info.shift(); }
        log.info.push(msg); return answers.info.shift();
      },
      showWarningMessage: async (msg, ...rest) => { log.warn.push(msg); if (rest[0] && rest[0].modal) return answers.warn.shift(); return undefined; },
      showInputBox: async (b) => { log.inputs.push(b); const v = answers.input.shift(); if (v != null && b.validateInput) { const e = b.validateInput(v); if (e) throw new Error('input rejected: ' + e); } return v; },
      showQuickPick: async (items, b) => { log.picks.push({ items, b }); const want = answers.pick.shift(); return want == null ? undefined : items.find((i) => i.id === want); },
      showSaveDialog: async (b) => { log.saves.push(b); const v = answers.save.shift(); return v === 'default' ? b.defaultUri : v; },
      showOpenDialog: async (b) => { log.opens.push(b); return answers.open.shift(); },
      setStatusBarMessage: (m) => { log.status.push(m); return { dispose() {} }; },
      withProgress: async (_o, fn) => fn({ report() {} }),
      showTextDocument: async () => {},
    },
    workspace: {
      workspaceFolders: o.folders ? o.folders.map((p) => ({ uri: Uri.file(p) })) : undefined,
      getWorkspaceFolder: (u) => (o.folders || []).filter((f) => u.path.startsWith(f + '/')).map((f) => ({ uri: Uri.file(f) }))[0],
      getConfiguration: () => ({ get: (k, d) => (k in settings ? settings[k] : d) }),
      fs: {
        stat: async (u) => { if (files.has(u.path)) return { size: files.get(u.path).length }; if (log.written.has(u.path)) return { size: 1 }; throw new Error('ENOENT'); },
        readFile: async (u) => { if (!files.has(u.path)) throw new Error('ENOENT'); return Buffer.from(files.get(u.path)); },
        writeFile: async (u, b) => { log.written.set(u.path, Buffer.from(b)); },
      },
      openTextDocument: async (u) => ({ uri: u }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
    },
    commands: { executeCommand: async (...a) => { log.commands.push(a); }, registerCommand: (id, fn) => ({ id, fn, dispose() {} }) },
    env: { openExternal: async (u) => { log.external.push(String(u)); return true; } },
    authentication: { getSession: async () => undefined, onDidChangeSessions: () => ({ dispose() {} }) },
  };
  const context = {
    globalState: { get: (k) => state.get(k), update: async (k, v) => { state.set(k, v); }, setKeysForSync() {} },
    secrets: { get: async () => undefined, store: async () => {}, delete: async () => {}, onDidChange: () => ({ dispose() {} }) },
    subscriptions: [],
  };
  return { vscode, context, log, answers, settings, state, Uri };
}

function fakeLicense(isPro) {
  const calls = { requirePro: [], refresh: 0 };
  return {
    calls,
    pro: isPro,
    isPro() { return this.pro; },
    refresh() { calls.refresh++; return Promise.resolve(); },
    requirePro: async (f, detail) => { calls.requirePro.push({ f, detail }); return false; },
    ready: Promise.resolve(),
    onDidChange: () => ({ dispose() {} }),
  };
}

// A provider with one open PDF whose "webview" runs the real pdf.js extractPages in Node.
async function setup(o) {
  const f = fakeVscode(o);
  const { createPro } = require('../src/pro');
  const { createPageTools } = require('../src/pageTools');
  const lic = fakeLicense(!!(o && o.pro));
  const pro = createPro({ vscode: f.vscode, context: f.context, license: lic });
  const doc = W.available ? await W.open((o && o.bytes) || SAMPLE) : null;
  const provider = { panels: new Set(), highlights: (o && o.highlights) || { entries: () => [] } };
  let tools;
  const entry = {
    uri: f.Uri.file('/w/docs/report.pdf'), pages: doc ? doc.numPages : 4, ready: true,
    panel: { visible: true, webview: { postMessage: (m) => { if (m.type === 'pageOp') W.runPageOp(doc, m).then((r) => tools.onResult(entry, parseWebviewMessage(r))); return Promise.resolve(true); } } },
  };
  provider.panels.add(entry);
  provider.active = entry;
  tools = createPageTools({ vscode: f.vscode, provider, pro });
  return Object.assign(f, { pro, lic, tools, entry, doc, provider });
}

test('host: extract writes the chosen pages, uses one free try, and says how many are left', { skip }, async () => {
  const t = await setup({ input: ['4, 1'], save: ['default'] });
  const out = await t.tools.extract();
  assert.equal(out.path, '/w/docs/report-p4_1.pdf');
  const texts = await W.pageTexts(t.log.written.get(out.path));
  const src = await W.pageTexts(SAMPLE);
  assert.deepEqual(texts, [src[3], src[0]]);
  assert.equal(t.pro.left('pages'), 2);
  assert.match(t.log.status[0], /free try of page tools used, 2 left/);
  assert.match(t.log.info[0], /2 pages extracted\. Saved report-p4_1\.pdf\./);
  await t.doc.destroy();
});

test('host: Escape at any step uses no try and writes nothing', { skip }, async () => {
  const t = await setup({ input: [undefined, '1', '2'], save: [undefined], pick: [undefined] });
  await t.tools.extract(); // Escape in the page box
  await t.tools.extract(); // Escape in the save dialog
  await t.tools.split(); // Escape in the mode pick
  assert.equal(t.log.written.size, 0);
  assert.equal(t.pro.left('pages'), 3);
  await t.doc.destroy();
});

test('host: after 3 tries the next use explains Pro once (modal) and runs nothing', { skip }, async () => {
  const t = await setup({ input: ['1', '2', '3'], save: ['default', 'default', 'default'] });
  for (let i = 0; i < 3; i++) await t.tools.extract();
  assert.equal(t.pro.left('pages'), 0);
  const before = t.log.inputs.length;
  await t.tools.remove();
  assert.equal(t.lic.calls.requirePro.length, 1);
  assert.equal(t.lic.calls.requirePro[0].f, 'Page tools');
  assert.match(t.lic.calls.requirePro[0].detail, /used the 3 free tries/);
  assert.match(t.lic.calls.requirePro[0].detail, /USD 19 once/);
  assert.match(t.lic.calls.requirePro[0].detail, /stays free/);
  assert.equal(t.log.inputs.length, before, 'no input box after the modal was cancelled');
  // Another Pro tool still has its own 3 tries.
  assert.equal(t.pro.left('merge'), 3);
  await t.doc.destroy();
});

test('host: a Pro user never uses tries and gets no Pro text', { skip }, async () => {
  const t = await setup({ pro: true, input: ['1-2'], save: ['default'] });
  await t.tools.extract();
  assert.equal(t.pro.left('pages'), 3);
  assert.equal(t.log.status.length, 0);
  assert.equal(t.lic.calls.requirePro.length, 0);
  assert.equal(t.pro.label('pages'), '');
  await t.doc.destroy();
});

test('host: delete pages, then refuse to delete every page', { skip }, async () => {
  const t = await setup({ input: ['2-3'], save: ['default'] });
  const out = await t.tools.remove();
  assert.equal(out.path, '/w/docs/report-edited.pdf');
  assert.equal((await W.pageTexts(t.log.written.get(out.path))).length, 2);
  const box = t.log.inputs[0];
  assert.match(box.validateInput('1-4'), /every page/);
  assert.equal(box.validateInput('1-3'), null);
  await t.doc.destroy();
});

test('host: split every 3 pages into a folder, asks before replacing files', { skip }, async () => {
  const t = await setup({ pick: ['every'], input: ['3'], open: [[null]] });
  t.answers.open[0] = [t.Uri.file('/w/out')];
  const outs = await t.tools.split();
  assert.deepEqual(outs.map((u) => u.path), ['/w/out/report-part-01-p1-3.pdf', '/w/out/report-part-02-p4.pdf']);
  assert.equal(t.pro.left('pages'), 2);
  // One file per page: 4 new names.
  t.answers.pick.push('each'); t.answers.open.push([t.Uri.file('/w/out')]);
  await t.tools.split();
  assert.equal(t.log.written.size, 6);
  assert.equal(t.pro.left('pages'), 1);
  // Same split again: the files exist; "Cancel" on the replace question writes nothing and uses no try.
  t.answers.pick.push('every'); t.answers.input.push('3'); t.answers.open.push([t.Uri.file('/w/out')]); t.answers.warn.push(undefined);
  await t.tools.split();
  assert.ok(t.log.warn.some((w) => /2 of the 2 files already exist/.test(w)));
  assert.equal(t.log.written.size, 6);
  assert.equal(t.pro.left('pages'), 1);
  await t.doc.destroy();
});

test('host: merge puts this PDF last when asked and counts all pages', { skip }, async () => {
  const t = await setup({ files: { '/w/docs/quake.pdf': QUAKE }, pick: ['last'], save: ['default'] });
  t.answers.open.push([t.Uri.file('/w/docs/quake.pdf'), t.Uri.file('/w/docs/report.pdf')]);
  const out = await t.tools.merge();
  assert.equal(out.path, '/w/docs/report-merged.pdf');
  const texts = await W.pageTexts(t.log.written.get(out.path));
  assert.equal(texts.length, 7);
  assert.deepEqual(texts.slice(0, 3), await W.pageTexts(QUAKE));
  assert.match(t.log.info[0], /2 PDFs merged, 7 pages/);
  assert.equal(t.pro.left('merge'), 2);
  assert.equal(t.pro.left('pages'), 3);
  await t.doc.destroy();
});

test('host: merge with a broken file shows the reason and uses no try', { skip }, async () => {
  const t = await setup({ files: { '/w/docs/bad.pdf': fs.readFileSync(FIX('broken.pdf')) }, pick: ['first'], save: ['default'] });
  t.answers.open.push([t.Uri.file('/w/docs/bad.pdf')]);
  await t.tools.merge();
  assert.match(t.log.warn[0], /Could not merge: file 1 of the merge is not a readable PDF/);
  assert.equal(t.log.written.size, 0);
  assert.equal(t.pro.left('merge'), 3);
  await t.doc.destroy();
});

test('host: export all highlights asks workspace or all, writes one Markdown file and opens it', async () => {
  const items = [{ id: 'a', page: 2, rects: [[0.1, 0.1, 0.1, 0.1]], text: 'cache hit rate', color: 'pink' }];
  const highlights = { entries: () => [{ key: 'file:///w/docs/report.pdf', items }, { key: 'file:///elsewhere/x.pdf', items }] };
  const t = await setup({ folders: ['/w'], highlights, pick: ['ws'], save: ['default'] });
  const out = await t.tools.exportAllHighlights();
  assert.equal(out.path, '/w/pdf-highlights.md');
  const md = t.log.written.get(out.path).toString('utf8');
  assert.match(md, /1 highlight in 1 PDF/);
  assert.match(md, /## docs\/report\.pdf/);
  assert.match(md, /"cache hit rate" \(\[page 2\]\(\/docs\/report\.pdf#page=2\), pink\)/);
  assert.doesNotMatch(md, /elsewhere/);
  assert.equal(t.pro.left('highlightsAll'), 2);
  if (t.doc) await t.doc.destroy();
});

test('host: showProFeatures=false hides the Pro button; Pro users always see it, without the badge', async () => {
  const { createPro } = require('../src/pro');
  const f = fakeVscode({ settings: { showProFeatures: false } });
  const lic = fakeLicense(false);
  const pro = createPro({ vscode: f.vscode, context: f.context, license: lic });
  assert.equal(pro.shown(), false);
  f.settings.showProFeatures = true;
  assert.equal(pro.shown(), true);
  assert.equal(pro.label('merge'), 'Pro, 3 free tries');
  f.settings.showProFeatures = false;
  lic.pro = true;
  assert.equal(pro.shown(), true);
  assert.equal(pro.label('merge'), '');
});

// ---------- activation: nothing about Pro on open, commands registered, no network ----------
test('activate: no message, no modal and no network at start; Pro commands are registered', async () => {
  const f = fakeVscode();
  const registered = [];
  f.vscode.commands.registerCommand = (id) => { registered.push(id); return { dispose() {} }; };
  f.vscode.window.registerCustomEditorProvider = () => ({ dispose() {} });
  f.vscode.window.registerUriHandler = () => ({ dispose() {} });
  f.vscode.workspace.createFileSystemWatcher = () => ({ onDidChange: () => ({}), onDidCreate: () => ({}), dispose() {} });
  f.vscode.RelativePattern = class {};
  f.vscode.env.uriScheme = 'vscode'; f.vscode.env.appName = 'Visual Studio Code';
  f.context.extensionUri = f.Uri.file('/ext');
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => { fetched++; throw new Error('no network in tests'); };
  const orig = Module._load;
  Module._load = function (req, ...rest) { return req === 'vscode' ? f.vscode : orig.call(this, req, ...rest); };
  try {
    delete require.cache[require.resolve('../src/extension')];
    const ext = require('../src/extension');
    const api = ext.activate(f.context);
    await api.pro.ready;
    await new Promise((r) => setTimeout(r, 20));
    for (const id of ['pdfViewer.pageTools', 'pdfViewer.extractPages', 'pdfViewer.deletePages', 'pdfViewer.splitPdf', 'pdfViewer.mergePdfs', 'pdfViewer.exportAllHighlights',
      'pdfViewer.getPro', 'pdfViewer.payWithPayPal', 'pdfViewer.unlockWithSponsors', 'pdfViewer.enterLicenseKey', 'pdfViewer.removeLicense']) assert.ok(registered.includes(id), id);
    assert.equal(f.log.info.length + f.log.warn.length + f.log.modal.length, 0);
    assert.equal(fetched, 0);
    const pkg = require('../package.json');
    const declared = pkg.contributes.commands.map((c) => c.command);
    for (const id of registered) assert.ok(declared.includes(id), 'declared in package.json: ' + id);
    assert.equal(api.provider.proState().show, true);
    assert.equal(api.provider.proState().badge, true);
  } finally {
    Module._load = orig;
    globalThis.fetch = realFetch;
  }
});

test('package.json: Pro commands hide with the setting, free commands do not', () => {
  const pkg = require('../package.json');
  const pal = pkg.contributes.menus.commandPalette;
  for (const id of ['pdfViewer.pageTools', 'pdfViewer.mergePdfs', 'pdfViewer.getPro', 'pdfViewer.exportAllHighlights']) {
    assert.match(pal.find((m) => m.command === id).when, /config\.pdfViewer\.showProFeatures/, id);
  }
  for (const m of pal) if (!/Pro|License|Sponsors|PayPal|getPro|pageTools|extractPages|deletePages|splitPdf|mergePdfs|exportAllHighlights/.test(m.command)) assert.doesNotMatch(m.when || '', /showProFeatures/, m.command);
  assert.equal(pkg.contributes.configuration.properties['pdfViewer.showProFeatures'].default, true);
});

test('host: the free try is counted when the file is written, even while the "Saved" message stays open', { skip }, async () => {
  const t = await setup({ input: ['1'], save: ['default'] });
  t.vscode.window.showInformationMessage = () => new Promise(() => {}); // the user never closes the toast
  t.tools.extract();
  const ok = await new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => (t.pro.left('pages') === 2 ? resolve(true) : Date.now() - t0 > 10000 ? resolve(false) : setTimeout(tick, 20));
    tick();
  });
  assert.ok(ok, 'try counted before the toast closed');
  assert.ok(t.log.written.has('/w/docs/report-p1.pdf'));
  await t.doc.destroy();
});
