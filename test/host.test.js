'use strict';
// Webview message protocol, CSP, state store, and the extension host against a fake `vscode` module.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');
const fs = require('fs');
const { parseWebviewMessage, readConfig } = require('../src/protocol');
const { buildHtml, escapeAttr } = require('../src/html');
const { StateStore, KEY } = require('../src/stateStore');
const { watchGlob, isSameFile } = require('../src/watch');

// ---------- protocol ----------
test('protocol: accepts known messages and cleans them', () => {
  assert.deepEqual(parseWebviewMessage({ type: 'ready', extra: 1 }), { type: 'ready' });
  assert.deepEqual(parseWebviewMessage({ type: 'state', page: 3, zoom: 'page-fit' }), { type: 'state', page: 3, zoom: 'page-fit' });
  assert.deepEqual(parseWebviewMessage({ type: 'state', page: 3, zoom: 99 }), { type: 'state', page: 3, zoom: undefined });
  assert.deepEqual(parseWebviewMessage({ type: 'openExternal', url: 'https://example.com/x?y=1' }), { type: 'openExternal', url: 'https://example.com/x?y=1' });
  assert.equal(parseWebviewMessage({ type: 'error', message: 'x'.repeat(2000) }).message.length, 500);
});

test('protocol: rejects unknown, malformed and dangerous messages', () => {
  for (const m of [null, 'ready', {}, { type: 'eval' }, { type: 'state', page: 0 }, { type: 'state', page: 1.5 }, { type: 'state', page: '2' },
    { type: 'openExternal', url: 'javascript:alert(1)' }, { type: 'openExternal', url: 'file:///etc/passwd' },
    { type: 'openExternal', url: 'command:workbench.action.terminal.new' }, { type: 'openExternal', url: 'vscode://ext/x' },
    { type: 'openExternal', url: 42 }, { type: 'info', pages: -1 }]) {
    assert.equal(parseWebviewMessage(m), null, JSON.stringify(m));
  }
});

test('protocol: readConfig normalises settings', () => {
  const cfg = (o) => readConfig((k, d) => (k in o ? o[k] : d));
  assert.deepEqual(cfg({}), { darkMode: 'auto', keepImagesInDarkMode: true, defaultZoom: 'page-width', rememberPage: true, maxFileSizeBytes: 200 * 1048576 });
  assert.equal(cfg({ darkMode: 'weird' }).darkMode, 'auto');
  assert.equal(cfg({ darkMode: 'on' }).darkMode, 'on');
  assert.equal(cfg({ defaultZoom: 'page-fit' }).defaultZoom, 'page-fit');
  assert.equal(cfg({ maxFileSizeMB: -5 }).maxFileSizeBytes, 200 * 1048576);
  assert.equal(cfg({ maxFileSizeMB: 1 }).maxFileSizeBytes, 1048576);
});

// ---------- CSP ----------
test('html: strict CSP, nonce on scripts, no remote or eval sources', () => {
  const uris = { core: 'https://r/core.js', viewer: 'https://r/viewer.js', css: 'https://r/v.css', pdfjs: 'https://r/pdf.min.mjs', worker: 'https://r/w.mjs', cmaps: 'https://r/c/', fonts: 'https://r/f/', wasm: 'https://r/w/' };
  const html = buildHtml(uris, 'https://r', 'NONCE1');
  const csp = /content="([^"]+)"/.exec(html)[1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'nonce-NONCE1' https:\/\/r 'wasm-unsafe-eval'/);
  assert.doesNotMatch(csp, /'unsafe-eval'|'unsafe-inline'|\*/);
  assert.match(csp, /worker-src blob:/);
  const scripts = html.match(/<script[^>]*>/g);
  assert.equal(scripts.length, 2);
  for (const s of scripts) assert.match(s, /nonce="NONCE1"/);
  assert.deepEqual([...new Set(html.match(/https?:\/\/[a-z0-9.-]+/gi))], ['https://r'], 'no other origins');
  assert.equal(escapeAttr('"><script>'), '&quot;&gt;&lt;script&gt;');
});

test('webview never writes file content with innerHTML', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'media', 'viewer.js'), 'utf8');
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(src, /\beval\(|new Function/);
  assert.doesNotMatch(src, /https?:\/\//, 'no hard-coded network URLs');
});

// ---------- state store ----------
function memento() {
  const m = new Map();
  return { get: (k) => m.get(k), update: async (k, v) => { if (v === undefined) m.delete(k); else m.set(k, JSON.parse(JSON.stringify(v))); }, raw: m };
}

test('stateStore: remembers page and zoom per file and caps entries', async () => {
  const mem = memento();
  const s = new StateStore(mem, 3);
  await s.set('file:///a.pdf', 4, 'page-fit');
  await s.set('file:///b.pdf', 2, 1.5);
  assert.deepEqual(s.get('file:///a.pdf'), { page: 4, zoom: 'page-fit' });
  await s.set('file:///c.pdf', 1, 1);
  await s.set('file:///a.pdf', 5, 1); // touch a so b is the oldest
  await s.set('file:///d.pdf', 1, 1);
  assert.equal(Object.keys(mem.raw.get(KEY)).length, 3);
  assert.equal(s.get('file:///b.pdf'), null);
  assert.deepEqual(s.get('file:///a.pdf'), { page: 5, zoom: 1 });
  await s.clear();
  assert.equal(s.get('file:///a.pdf'), null);
});

test('stateStore: survives junk in storage', () => {
  const s = new StateStore({ get: () => ['junk'], update: async () => {} });
  assert.equal(s.get('x'), null);
  const s2 = new StateStore({ get: () => ({ x: { page: 'NaN' } }), update: async () => {} });
  assert.equal(s2.get('x'), null);
});

// ---------- extension host with fake vscode ----------
function makeVscode(files, settings) {
  const watchers = [];
  const commands = new Map();
  const opened = [];
  let provider = null;
  class Uri {
    constructor(scheme, p) { this.scheme = scheme; this.path = p; this.fsPath = p; }
    static file(p) { return new Uri('file', p); }
    static parse(s) { const u = new URL(s); return Object.assign(new Uri(u.protocol.slice(0, -1), u.pathname), { raw: s }); }
    static joinPath(u, ...parts) { return new Uri(u.scheme, path.posix.join(u.path, ...parts)); }
    toString() { return this.raw || this.scheme + '://' + this.path; }
  }
  const ev = () => { const ls = []; const f = (l) => { ls.push(l); return { dispose() {} }; }; f.fire = (x) => ls.forEach((l) => l(x)); return f; };
  const vscode = {
    Uri,
    RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
    window: {
      registerCustomEditorProvider: (id, p, opts) => { provider = { id, p, opts }; return { dispose() {} }; },
      showInformationMessage: async () => undefined,
      showOpenDialog: async () => undefined,
    },
    commands: { registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; }, executeCommand: async () => {} },
    env: { openExternal: async (u) => { opened.push(u.toString()); return true; } },
    workspace: {
      getConfiguration: () => ({ get: (k, d) => (k in settings ? settings[k] : d) }),
      onDidChangeConfiguration: ev(),
      fs: {
        stat: async (u) => { if (!(u.path in files)) throw new Error('ENOENT ' + u.path); return { size: files[u.path].length }; },
        readFile: async (u) => { if (!(u.path in files)) throw new Error('ENOENT ' + u.path); return files[u.path]; },
      },
      createFileSystemWatcher: (pattern) => {
        const w = { pattern, onDidChange: ev(), onDidCreate: ev(), onDidDelete: ev(), dispose() {} };
        watchers.push(w);
        return w;
      },
    },
  };
  return { vscode, watchers, commands, opened, getProvider: () => provider };
}

function loadExtension(fake) {
  const orig = Module._load;
  Module._load = function (req, ...rest) { return req === 'vscode' ? fake.vscode : orig.call(this, req, ...rest); };
  try {
    const p = require.resolve('../src/extension');
    delete require.cache[p];
    return require('../src/extension');
  } finally { Module._load = orig; }
}

function fakePanel() {
  const sent = [];
  let onMsg = null;
  let onDispose = null;
  const webview = {
    cspSource: 'https://fake.vscode-resource',
    options: null,
    html: '',
    asWebviewUri: (u) => ({ toString: () => 'https://fake.vscode-resource' + u.path }),
    postMessage: async (m) => { sent.push(m); return true; },
    onDidReceiveMessage: (fn) => { onMsg = fn; return { dispose() {} }; },
  };
  let onView = null;
  const panel = { webview, active: true, visible: true, onDidChangeViewState: (fn) => { onView = fn; return { dispose() {} }; }, onDidDispose: (fn) => { onDispose = fn; } };
  return {
    sent,
    receive: (m) => onMsg(m),
    dispose: () => onDispose && onDispose(),
    // VS Code fires onDidChangeViewState when the tab is hidden, shown, or gains or loses focus.
    setView: (active, visible) => { panel.active = active; panel.visible = visible; if (onView) onView({ webviewPanel: panel }); },
    panel,
  };
}

function context() {
  return { subscriptions: [], extensionUri: { scheme: 'file', path: '/ext', fsPath: '/ext' }, globalState: memento() };
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test('extension: open, ready -> init + load, remember page, reload on change', async () => {
  const pdf = new Uint8Array([37, 80, 68, 70, 45]);
  const fake = makeVscode({ '/docs/a.pdf': pdf }, {});
  fake.vscode.Uri.joinPath = (u, ...parts) => new fake.vscode.Uri(u.scheme, path.posix.join(u.path, ...parts));
  const ext = loadExtension(fake);
  const ctx = context();
  ext.activate(ctx);
  const reg = fake.getProvider();
  assert.equal(reg.id, 'pdfViewer.preview');
  assert.equal(reg.opts.webviewOptions.retainContextWhenHidden, true);
  const uri = fake.vscode.Uri.file('/docs/a.pdf');
  const doc = reg.p.openCustomDocument(uri);
  const fp = fakePanel();
  await reg.p.resolveCustomEditor(doc, fp.panel);
  assert.equal(fp.panel.webview.options.enableScripts, true);
  assert.deepEqual(fp.panel.webview.options.localResourceRoots.map((u) => u.path), ['/ext/media']);
  assert.match(fp.panel.webview.html, /Content-Security-Policy/);
  // the file folder is not a resource root: data goes through postMessage only
  assert.doesNotMatch(fp.panel.webview.html, /\/docs\//);

  fp.receive({ type: 'ready' });
  await tick();
  assert.equal(fp.sent[0].type, 'init');
  assert.equal(fp.sent[0].fileName, 'a.pdf');
  assert.equal(fp.sent[0].state, null);
  assert.equal(fp.sent[1].type, 'load');
  assert.deepEqual(Array.from(fp.sent[1].data), Array.from(pdf));
  assert.equal(fp.sent[1].reload, false);

  fp.receive({ type: 'state', page: 7, zoom: 1.25 });
  fp.receive({ type: 'state', page: 'x' }); // ignored
  await tick();
  assert.deepEqual(new (require('../src/stateStore').StateStore)(ctx.globalState).get(uri.toString()), { page: 7, zoom: 1.25 });

  // watcher on the file's folder and name
  const w = fake.watchers[0];
  assert.equal(w.pattern.base.path, '/docs');
  assert.equal(w.pattern.pattern, 'a.pdf');
  w.onDidChange.fire(uri);
  w.onDidChange.fire(uri); // debounced into one reload
  await tick(350);
  const reloads = fp.sent.filter((m) => m.type === 'load' && m.reload);
  assert.equal(reloads.length, 1);

  // a second open restores the page
  const fp2 = fakePanel();
  await reg.p.resolveCustomEditor(reg.p.openCustomDocument(uri), fp2.panel);
  fp2.receive({ type: 'ready' });
  await tick();
  assert.deepEqual(fp2.sent[0].state, { page: 7, zoom: 1.25 });
  fp.dispose();
  fp2.dispose();
});

test('extension: links open only for safe schemes', async () => {
  const fake = makeVscode({ '/a.pdf': new Uint8Array(1) }, {});
  const ext = loadExtension(fake);
  ext.activate(context());
  const reg = fake.getProvider();
  const fp = fakePanel();
  await reg.p.resolveCustomEditor(reg.p.openCustomDocument(fake.vscode.Uri.file('/a.pdf')), fp.panel);
  fp.receive({ type: 'openExternal', url: 'javascript:alert(1)' });
  fp.receive({ type: 'openExternal', url: 'command:workbench.action.terminal.new' });
  fp.receive({ type: 'openExternal', url: 'https://example.com/paper' });
  await tick();
  assert.equal(fake.opened.length, 1);
  assert.match(fake.opened[0], /example\.com/);
});

test('extension: large file asks first, then loads on loadAnyway', async () => {
  const big = new Uint8Array(3 * 1048576);
  const fake = makeVscode({ '/big.pdf': big }, { maxFileSizeMB: 1 });
  const ext = loadExtension(fake);
  ext.activate(context());
  const reg = fake.getProvider();
  const fp = fakePanel();
  await reg.p.resolveCustomEditor(reg.p.openCustomDocument(fake.vscode.Uri.file('/big.pdf')), fp.panel);
  fp.receive({ type: 'ready' });
  await tick();
  const tl = fp.sent.find((m) => m.type === 'tooLarge');
  assert.ok(tl);
  assert.equal(tl.size, big.length);
  assert.equal(tl.limit, 1048576);
  assert.equal(fp.sent.filter((m) => m.type === 'load').length, 0);
  fp.receive({ type: 'loadAnyway' });
  await tick();
  assert.equal(fp.sent.filter((m) => m.type === 'load').length, 1);
});

test('extension: missing file sends a readable error', async () => {
  const fake = makeVscode({}, {});
  const ext = loadExtension(fake);
  ext.activate(context());
  const reg = fake.getProvider();
  const fp = fakePanel();
  await reg.p.resolveCustomEditor(reg.p.openCustomDocument(fake.vscode.Uri.file('/gone.pdf')), fp.panel);
  fp.receive({ type: 'ready' });
  await tick();
  const err = fp.sent.find((m) => m.type === 'error');
  assert.match(err.message, /ENOENT/);
});

test('extension: palette commands reach the active viewer', async () => {
  const fake = makeVscode({ '/a.pdf': new Uint8Array(1) }, {});
  const ext = loadExtension(fake);
  ext.activate(context());
  const reg = fake.getProvider();
  const fp = fakePanel();
  await reg.p.resolveCustomEditor(reg.p.openCustomDocument(fake.vscode.Uri.file('/a.pdf')), fp.panel);
  await fake.commands.get('pdfViewer.toggleDarkMode')();
  await fake.commands.get('pdfViewer.fitPage')();
  assert.deepEqual(fp.sent.filter((m) => m.type === 'command').map((m) => m.name), ['toggleDarkMode', 'fitPage']);
  const pkg = require('../package.json');
  for (const c of pkg.contributes.commands) assert.ok(fake.commands.has(c.command), 'registered: ' + c.command);
});

test('toPlainBytes: Node Buffers become plain Uint8Array copies (VS Code would JSON-serialise a Buffer)', () => {
  const fake = makeVscode({}, {});
  const { toPlainBytes } = loadExtension(fake);
  const buf = Buffer.from('%PDF-1.7 test');
  assert.ok(buf.buffer.byteLength > buf.length, 'small Buffers live in a shared pool');
  const out = toPlainBytes(buf);
  assert.equal(Object.getPrototypeOf(out), Uint8Array.prototype);
  assert.equal(out.buffer.byteLength, buf.length);
  assert.equal(Buffer.from(out).toString(), '%PDF-1.7 test');
  assert.equal(JSON.stringify({ d: out }).includes('Buffer'), false);
  const plain = new Uint8Array([1, 2, 3]);
  assert.equal(toPlainBytes(plain), plain);
});

test('manifest: zoom keys are keybindings scoped to the PDF editor (webview keys are also forwarded to VS Code)', () => {
  const pkg = require('../package.json');
  const kb = pkg.contributes.keybindings;
  for (const cmd of ['pdfViewer.zoomIn', 'pdfViewer.zoomOut', 'pdfViewer.find']) {
    const k = kb.find((x) => x.command === cmd);
    assert.ok(k, cmd);
    assert.match(k.when, /activeCustomEditorId == pdfViewer\.preview/);
    assert.match(k.when, /!sideBarFocus/);
  }
  const src = fs.readFileSync(path.join(__dirname, '..', 'media', 'viewer.js'), 'utf8');
  assert.doesNotMatch(src, /e\.key === '='|e\.key === '-'/, 'webview must not also handle zoom keys');
});

// ---------- R7 fixes ----------
test('watch: glob characters in the file name become single-character wildcards', () => {
  assert.equal(watchGlob('a.pdf'), 'a.pdf');
  assert.equal(watchGlob('paper[1].pdf'), 'paper?1?.pdf');
  assert.equal(watchGlob('notes{v2}.pdf'), 'notes?v2?.pdf');
  assert.equal(watchGlob('what?*.pdf'), 'what??.pdf');
  assert.equal(watchGlob('a,b !c (d).pdf'), 'a,b !c (d).pdf');
  assert.ok(isSameFile({ path: '/d/paper[1].pdf' }, 'paper[1].pdf'));
  assert.ok(!isSameFile({ path: '/d/paperX1Y.pdf' }, 'paper[1].pdf'));
  assert.ok(isSameFile(undefined, 'a.pdf'), 'events without a URI still reload');
});

test('extension: a PDF named with glob characters still reloads when it changes on disk (R7 P2)', async () => {
  const name = '/docs/paper[1] {v2}.pdf';
  const fake = makeVscode({ [name]: new Uint8Array([37, 80, 68, 70]) }, {});
  const ext = loadExtension(fake);
  ext.activate(context());
  const reg = fake.getProvider();
  const fp = fakePanel();
  const uri = fake.vscode.Uri.file(name);
  await reg.p.resolveCustomEditor(reg.p.openCustomDocument(uri), fp.panel);
  fp.receive({ type: 'ready' });
  await tick();
  const w = fake.watchers[0];
  assert.equal(w.pattern.base.path, '/docs');
  assert.equal(w.pattern.pattern, 'paper?1? ?v2?.pdf');
  assert.doesNotMatch(w.pattern.pattern, /[[\]{}*]/, 'no raw glob syntax from the file name');
  // a look-alike file that also matches the wildcard glob does not reload this PDF
  w.onDidChange.fire(fake.vscode.Uri.file('/docs/paperX1Y Zv2W.pdf'));
  await tick(350);
  assert.equal(fp.sent.filter((m) => m.type === 'load' && m.reload).length, 0);
  w.onDidChange.fire(uri);
  await tick(350);
  assert.equal(fp.sent.filter((m) => m.type === 'load' && m.reload).length, 1);
  fp.dispose();
});

test('extension: hiding the tab tells the webview to free its pages, showing it redraws (R7 P3)', async () => {
  const fake = makeVscode({ '/a.pdf': new Uint8Array(1) }, {});
  const ext = loadExtension(fake);
  ext.activate(context());
  const reg = fake.getProvider();
  const fp = fakePanel();
  await reg.p.resolveCustomEditor(reg.p.openCustomDocument(fake.vscode.Uri.file('/a.pdf')), fp.panel);
  const vis = () => fp.sent.filter((m) => m.type === 'visibility').map((m) => m.visible);
  fp.setView(false, false); // before ready: nothing to free yet
  assert.deepEqual(vis(), []);
  fp.setView(true, true);
  fp.receive({ type: 'ready' });
  await tick();
  assert.deepEqual(vis(), []);
  fp.setView(false, true); // focus moved to another editor group, tab still on screen
  assert.deepEqual(vis(), []);
  fp.setView(false, false);
  fp.setView(false, false);
  assert.deepEqual(vis(), [false], 'one message per change');
  fp.setView(true, true);
  assert.deepEqual(vis(), [false, true]);
  fp.dispose();
});

test('extension: a webview that reloads while its tab is hidden is told it is hidden (R7 P3)', async () => {
  const fake = makeVscode({ '/a.pdf': new Uint8Array(1) }, {});
  const ext = loadExtension(fake);
  ext.activate(context());
  const reg = fake.getProvider();
  const fp = fakePanel();
  await reg.p.resolveCustomEditor(reg.p.openCustomDocument(fake.vscode.Uri.file('/a.pdf')), fp.panel);
  fp.panel.visible = false;
  fp.receive({ type: 'ready' });
  await tick();
  const types = fp.sent.map((m) => m.type);
  assert.deepEqual(types.slice(0, 1), ['init']);
  assert.deepEqual(fp.sent.filter((m) => m.type === 'visibility'), [{ type: 'visibility', visible: false }]);
  fp.dispose();
});

test('webview: handles the visibility message and skips drawing while hidden', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'media', 'viewer.js'), 'utf8');
  assert.match(src, /case 'visibility':/);
  assert.match(src, /function renderVisible\(\) \{\n\s*if \(!S\.doc \|\| S\.hidden\) return;/);
});

test('manifest and README: links point at the public repo, images use absolute raw URLs that exist locally (R7 P1)', () => {
  const pkg = require('../package.json');
  const repo = 'https://github.com/theluckystrike/pdf-viewer-vscode';
  assert.equal(pkg.repository.url, repo + '.git');
  assert.equal(pkg.bugs.url, repo + '/issues');
  assert.ok(pkg.homepage.startsWith(repo));
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const imgs = [...readme.matchAll(/<img[^>]*\ssrc="([^"]+)"/g), ...readme.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)].map((m) => m[1]).filter((u) => !u.includes('img.shields.io'));
  assert.ok(imgs.length >= 4, 'at least 4 screenshots');
  // the Marketplace needs absolute image URLs; raw.githubusercontent.com on main
  const raw = 'https://raw.githubusercontent.com/theluckystrike/pdf-viewer-vscode/main/';
  for (const u of imgs) {
    assert.ok(u.startsWith(raw), u);
    assert.ok(fs.existsSync(path.join(__dirname, '..', u.slice(raw.length))), 'file exists: ' + u);
  }
  // no relative links: vsce would rewrite them to a guessed URL, and test/ is not in the VSIX
  const links = [...readme.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]);
  for (const l of links) assert.match(l, /^(https:|mailto:|#)/, l);
});
