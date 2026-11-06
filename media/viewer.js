// PDF webview. Runs as an ES module inside the VS Code webview. pdf.js is bundled and loaded from the
// extension folder; nothing is fetched from the network. File content (titles, text, links) is only ever
// written with textContent or element properties, never parsed as HTML.
/* global PdfCore, acquireVsCodeApi */
const C = PdfCore;
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
const DATA = document.body.dataset;
const MAX_CANVAS_PIXELS = 16 * 1024 * 1024;
const KEEP_RENDERED = 14;

let pdfjsLib = null;
let workerPort = null;

const S = {
  config: { darkMode: 'auto', keepImagesInDarkMode: true, defaultZoom: 'page-width', searchCaseSensitive: false },
  doc: null,
  loadingTask: null,
  numPages: 0,
  sizes: [], // unscaled page sizes in CSS px {width, height}
  pageEls: [],
  tops: [],
  heights: [],
  zoom: 'page-width',
  scale: 1,
  page: 1,
  pendingRestore: null,
  darkOverride: null, // null = follow config, true/false = toggled by the user in this view
  rendered: new Map(), // pageIndex -> {scale, dark, task}
  textCache: new Map(), // pageIndex -> textContent items
  imageRectCache: new Map(),
  search: { id: 0, query: '', matches: [], byPage: new Map(), total: 0, selected: -1, done: true },
  thumbsObserver: null,
  thumbsRendered: new Set(),
  docId: 0,
  hidden: false, // true while the VS Code tab is hidden; page canvases are freed then
};

// ---------- messaging ----------
function post(msg) { vscode.postMessage(msg); }
let stateTimer = null;
function saveState() {
  clearTimeout(stateTimer);
  stateTimer = setTimeout(() => {
    const st = { page: S.page, zoom: S.zoom };
    vscode.setState(st);
    post({ type: 'state', page: S.page, zoom: S.zoom });
  }, 400);
}

window.addEventListener('message', (ev) => {
  const m = ev.data;
  if (!m || typeof m !== 'object') return;
  switch (m.type) {
    case 'init':
      if (m.config) S.config = Object.assign(S.config, m.config);
      if (m.state && !S.pendingRestore) S.pendingRestore = m.state;
      $('fileName').textContent = typeof m.fileName === 'string' ? m.fileName : '';
      applyDarkClass();
      break;
    case 'load':
      openDocument(m.data, !!m.reload).catch(showError);
      break;
    case 'tooLarge':
      showTooLarge(m.size, m.limit);
      break;
    case 'error':
      showError(new Error(String(m.message || 'Unknown error')));
      break;
    case 'config':
      S.config = Object.assign(S.config, m.config || {});
      onDarkChanged();
      break;
    case 'command':
      runCommand(m.name);
      break;
    case 'visibility':
      setVisible(m.visible !== false);
      break;
  }
});

function runCommand(name) {
  if (name === 'toggleDarkMode') toggleDark();
  else if (name === 'find') focusSearch();
  else if (name === 'zoomIn') setZoom(C.nextZoom(S.scale, 1));
  else if (name === 'zoomOut') setZoom(C.nextZoom(S.scale, -1));
  else if (name === 'fitWidth') setZoom('page-width');
  else if (name === 'fitPage') setZoom('page-fit');
  else if (name === 'toggleSidebar') toggleSidebar();
}

// ---------- pdf.js setup ----------
async function ensurePdfjs() {
  if (pdfjsLib) return pdfjsLib;
  pdfjsLib = await import(DATA.pdfjs);
  // Webviews cannot start a worker from the extension origin, so we load the bundled worker file
  // into a blob URL. The code is the same file shipped in the extension.
  const res = await fetch(DATA.worker);
  if (!res.ok) throw new Error('Could not load the bundled pdf.js worker.');
  const blob = new Blob([await res.text()], { type: 'text/javascript' });
  workerPort = new Worker(URL.createObjectURL(blob), { type: 'module' });
  pdfjsLib.GlobalWorkerOptions.workerPort = workerPort;
  return pdfjsLib;
}

async function openDocument(data, isReload) {
  const lib = await ensurePdfjs();
  hideMessage();
  const keep = isReload && S.doc ? { page: S.page, zoom: S.zoom, scrollRatio: scrollRatioInPage() } : null;
  if (S.loadingTask) { try { await S.loadingTask.destroy(); } catch { /* ignore */ } }
  resetDocState();
  S.reportedRender = false;
  const myId = ++S.docId;
  $('status').textContent = 'Loading…';
  const task = lib.getDocument({
    data: C.toBytes(data),
    cMapUrl: DATA.cmaps,
    cMapPacked: true,
    standardFontDataUrl: DATA.fonts,
    wasmUrl: DATA.wasm,
    useWorkerFetch: false,
    isEvalSupported: false,
    enableXfa: false,
    disableAutoFetch: true,
  });
  S.loadingTask = task;
  task.onPassword = (update, reason) => askPassword(update, reason);
  const doc = await task.promise;
  if (myId !== S.docId) return;
  S.doc = doc;
  S.numPages = doc.numPages;
  $('pageCount').textContent = String(doc.numPages);
  $('pageInput').max = String(doc.numPages);
  const first = await doc.getPage(1);
  const vp = first.getViewport({ scale: 1 });
  S.sizes = new Array(doc.numPages).fill(null).map(() => ({ width: vp.width, height: vp.height }));
  const restore = keep || S.pendingRestore || vscode.getState() || null;
  S.pendingRestore = null;
  S.zoom = restore && restore.zoom != null ? restore.zoom : S.config.defaultZoom;
  buildPages();
  applyZoom(false);
  const startPage = restore && Number.isInteger(restore.page) ? Math.min(Math.max(1, restore.page), S.numPages) : 1;
  scrollToPage(startPage, null, keep ? keep.scrollRatio : 0);
  $('status').textContent = '';
  post({ type: 'info', pages: doc.numPages });
  scheduleRender();
  loadSizesInBackground(myId);
  loadOutline(myId);
  buildThumbs();
  if (S.search.query) startSearch(S.search.query, true);
}

function resetDocState() {
  S.doc = null;
  S.numPages = 0;
  S.rendered.forEach((r) => r.task && r.task.cancel && r.task.cancel());
  S.rendered.clear();
  S.textCache.clear();
  S.imageRectCache.clear();
  S.thumbsRendered.clear();
  if (S.thumbsObserver) S.thumbsObserver.disconnect();
  $('pages').replaceChildren();
  $('outline').replaceChildren();
  $('thumbs').replaceChildren();
  S.pageEls = [];
  S.search.matches = [];
  S.search.byPage = new Map();
  S.search.total = 0;
  S.search.selected = -1;
}

async function loadSizesInBackground(myId) {
  // Pages can differ in size. Fetch them in small batches so the first page shows at once.
  let changed = false;
  for (let i = 2; i <= S.numPages; i++) {
    if (myId !== S.docId) return;
    const p = await S.doc.getPage(i);
    const vp = p.getViewport({ scale: 1 });
    const s = S.sizes[i - 1];
    if (Math.abs(s.width - vp.width) > 0.5 || Math.abs(s.height - vp.height) > 0.5) {
      S.sizes[i - 1] = { width: vp.width, height: vp.height };
      changed = true;
    }
    if (i % 50 === 0 || i === S.numPages) {
      if (changed) { relayoutKeepingPosition(); changed = false; }
      await new Promise((r) => setTimeout(r, 0));
    }
  }
}

// ---------- layout ----------
function buildPages() {
  const frag = document.createDocumentFragment();
  S.pageEls = [];
  for (let i = 0; i < S.numPages; i++) {
    const el = document.createElement('div');
    el.className = 'page';
    el.dataset.page = String(i + 1);
    const label = document.createElement('div');
    label.className = 'pageLabel';
    label.textContent = String(i + 1);
    el.appendChild(label);
    frag.appendChild(el);
    S.pageEls.push(el);
  }
  $('pages').replaceChildren(frag);
}

function containerSize() {
  const v = $('viewer');
  return { width: v.clientWidth, height: v.clientHeight };
}

function applyZoom(keepPosition) {
  if (!S.numPages) return;
  const anchor = keepPosition ? { page: S.page, ratio: scrollRatioInPage() } : null;
  S.scale = C.computeScale(S.zoom, S.sizes[Math.max(0, S.page - 1)] || S.sizes[0], containerSize());
  layoutPages();
  updateZoomUi();
  if (anchor) scrollToPage(anchor.page, null, anchor.ratio);
  invalidateAll();
}

function layoutPages() {
  S.tops = [];
  S.heights = [];
  for (let i = 0; i < S.numPages; i++) {
    const el = S.pageEls[i];
    const w = Math.round(S.sizes[i].width * S.scale);
    const h = Math.round(S.sizes[i].height * S.scale);
    el.style.width = w + 'px';
    el.style.height = h + 'px';
    el.style.setProperty('--scale-factor', String(S.scale));
    el.style.setProperty('--total-scale-factor', String(S.scale));
  }
  for (let i = 0; i < S.numPages; i++) {
    S.tops.push(S.pageEls[i].offsetTop);
    S.heights.push(S.pageEls[i].offsetHeight);
  }
}

function relayoutKeepingPosition() {
  const anchor = { page: S.page, ratio: scrollRatioInPage() };
  if (typeof S.zoom === 'string') S.scale = C.computeScale(S.zoom, S.sizes[0], containerSize());
  layoutPages();
  scrollToPage(anchor.page, null, anchor.ratio);
  invalidateAll();
}

function scrollRatioInPage() {
  const i = S.page - 1;
  if (!S.heights[i]) return 0;
  return ($('viewer').scrollTop - S.tops[i]) / S.heights[i];
}

function scrollToPage(pageNum, pdfTop, ratio) {
  const i = Math.min(Math.max(1, pageNum), S.numPages) - 1;
  if (i < 0 || !S.pageEls[i]) return;
  let y = S.tops[i];
  if (typeof pdfTop === 'number' && S.doc) {
    const h = S.sizes[i].height; // PDF y grows upward; page height in PDF units = h at scale 1
    y += Math.max(0, (h - pdfTop) * S.scale) - 8;
  } else if (typeof ratio === 'number' && isFinite(ratio)) {
    y += ratio * S.heights[i];
  } else {
    y -= 8;
  }
  $('viewer').scrollTop = Math.max(0, y);
  S.page = i + 1;
  updatePageUi();
  scheduleRender();
}

// ---------- rendering ----------
let renderScheduled = false;
function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    renderVisible();
  });
}

function isDarkNow() {
  if (S.darkOverride != null) return S.darkOverride;
  const kind = document.body.dataset.vscodeThemeKind || themeKindFromClass();
  return C.isDark(S.config.darkMode, kind);
}
function themeKindFromClass() {
  const cl = document.body.classList;
  if (cl.contains('vscode-high-contrast-light')) return 'vscode-high-contrast-light';
  if (cl.contains('vscode-high-contrast')) return 'vscode-high-contrast';
  if (cl.contains('vscode-dark')) return 'vscode-dark';
  return 'vscode-light';
}
function applyDarkClass() {
  const dark = isDarkNow();
  document.body.classList.toggle('pdf-dark', dark);
  $('darkBtn').setAttribute('aria-pressed', dark ? 'true' : 'false');
  $('darkBtn').title = dark ? 'Dark pages: on (click for light pages)' : 'Dark pages: off (click for dark pages)';
}
function onDarkChanged() {
  S.reportedRender = false;
  applyDarkClass();
  invalidateAll();
  S.thumbsRendered.clear();
  document.querySelectorAll('#thumbs canvas').forEach((c) => { c.width = 0; c.height = 0; });
  if (S.thumbsObserver) document.querySelectorAll('#thumbs .thumb').forEach((t) => { S.thumbsObserver.unobserve(t); S.thumbsObserver.observe(t); });
}
function toggleDark() {
  S.darkOverride = !isDarkNow();
  onDarkChanged();
}

function invalidateAll() {
  S.rendered.forEach((r) => { if (r.task && r.task.cancel) r.task.cancel(); r.stale = true; });
  scheduleRender();
}

// Hidden tabs keep their webview, and each rendered page canvas can hold up to 64 MB at high zoom.
// Free them while hidden. Page boxes keep their size, so the scroll position does not move.
function setVisible(visible) {
  const action = C.visibilityAction(!S.hidden, visible);
  S.hidden = !visible;
  if (action === 'free') [...S.rendered.keys()].forEach(freePage);
  else if (action === 'render') { S.reportedRender = false; scheduleRender(); }
}

function renderVisible() {
  if (!S.doc || S.hidden) return;
  const v = $('viewer');
  const vis = C.visiblePages(S.tops, S.heights, v.scrollTop, v.clientHeight, v.clientHeight * 0.75);
  const newPage = C.currentPage(S.tops, S.heights, v.scrollTop, v.clientHeight);
  if (newPage !== S.page) { S.page = newPage; updatePageUi(); saveState(); }
  const want = new Set(vis);
  for (const i of vis) {
    const r = S.rendered.get(i);
    if (!r || r.stale || r.scale !== S.scale) renderPage(i).catch(renderErr);
  }
  // free far pages
  if (S.rendered.size > KEEP_RENDERED) {
    const far = [...S.rendered.keys()].filter((i) => !want.has(i)).sort((a, b) => Math.abs(b - S.page) - Math.abs(a - S.page));
    for (const i of far.slice(0, S.rendered.size - KEEP_RENDERED)) freePage(i);
  }
}
function renderErr(e) {
  if (e && e.name === 'RenderingCancelledException') return;
  console.error(e);
}
function freePage(i) {
  const r = S.rendered.get(i);
  if (r && r.task && r.task.cancel) r.task.cancel();
  S.rendered.delete(i);
  const el = S.pageEls[i];
  if (!el) return;
  el.querySelectorAll('canvas').forEach((c) => { c.width = 0; c.height = 0; });
  el.querySelectorAll('.canvasWrap,.textLayer,.linkLayer').forEach((n) => n.remove());
}

async function pageImageRects(page, i) {
  if (S.imageRectCache.has(i)) return S.imageRectCache.get(i);
  const ops = await page.getOperatorList();
  const rects = C.imageRects(ops.fnArray, ops.argsArray, pdfjsLib.OPS);
  S.imageRectCache.set(i, rects);
  return rects;
}

/** Inverts a rendered page, then paints the original pixels back over raster images. */
function darkenCanvas(canvas, rects) {
  const w = canvas.width;
  const h = canvas.height;
  if (!w || !h) return;
  const copy = document.createElement('canvas');
  copy.width = w;
  copy.height = h;
  copy.getContext('2d').drawImage(canvas, 0, 0);
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'copy';
  ctx.filter = 'invert(0.88) hue-rotate(180deg)';
  ctx.drawImage(copy, 0, 0);
  ctx.filter = 'none';
  ctx.globalCompositeOperation = 'source-over';
  for (const r of rects) ctx.drawImage(copy, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
  ctx.restore();
  copy.width = 0;
  copy.height = 0;
}

async function drawPage(page, canvas, cssScale, dark) {
  const vp = page.getViewport({ scale: cssScale });
  const dpr = window.devicePixelRatio || 1;
  const os = Math.min(dpr, Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, vp.width * vp.height)));
  canvas.width = Math.max(1, Math.floor(vp.width * os));
  canvas.height = Math.max(1, Math.floor(vp.height * os));
  canvas.style.width = Math.floor(vp.width) + 'px';
  canvas.style.height = Math.floor(vp.height) + 'px';
  const ctx = canvas.getContext('2d', { alpha: false });
  const task = page.render({ canvasContext: ctx, canvas, viewport: vp, transform: os !== 1 ? [os, 0, 0, os, 0, 0] : null, background: '#ffffff' });
  return { vp, os, task };
}

async function renderPage(i) {
  const docId = S.docId;
  const scale = S.scale;
  const dark = isDarkNow();
  const prev = S.rendered.get(i);
  if (prev && prev.task && prev.task.cancel) prev.task.cancel();
  const entry = { scale, dark, task: null, stale: false };
  S.rendered.set(i, entry);
  const page = await S.doc.getPage(i + 1);
  if (docId !== S.docId || S.rendered.get(i) !== entry) return;
  const el = S.pageEls[i];
  const canvas = document.createElement('canvas');
  const { vp, os, task } = await drawPage(page, canvas, scale, dark);
  entry.task = task;
  await task.promise;
  if (docId !== S.docId || S.rendered.get(i) !== entry) { canvas.width = 0; return; }
  if (dark) {
    const rects = S.config.keepImagesInDarkMode ? await pageImageRects(page, i) : [];
    const tf = C.multiply([os, 0, 0, os, 0, 0], vp.transform);
    darkenCanvas(canvas, C.toCanvasRects(rects, tf, canvas.width, canvas.height));
  }
  const wrap = document.createElement('div');
  wrap.className = 'canvasWrap';
  wrap.appendChild(canvas);
  el.querySelectorAll('.canvasWrap,.textLayer,.linkLayer').forEach((n) => n.remove());
  el.appendChild(wrap);
  entry.task = null;
  if (!S.reportedRender) { S.reportedRender = true; post({ type: 'rendered', page: i + 1, dark }); }
  await addTextLayer(page, i, el, vp, entry);
  await addLinks(page, el, vp, entry);
}

async function getTextItems(i) {
  if (S.textCache.has(i)) return S.textCache.get(i);
  const page = await S.doc.getPage(i + 1);
  const tc = await page.getTextContent();
  const items = tc.items.filter((it) => typeof it.str === 'string');
  const val = { items, styles: tc.styles, lang: tc.lang };
  S.textCache.set(i, val);
  return val;
}

async function addTextLayer(page, i, el, vp, entry) {
  const tc = await getTextItems(i);
  if (S.rendered.get(i) !== entry) return;
  const div = document.createElement('div');
  div.className = 'textLayer';
  el.appendChild(div);
  const tl = new pdfjsLib.TextLayer({ textContentSource: { items: tc.items, styles: tc.styles, lang: tc.lang }, container: div, viewport: vp });
  await tl.render();
  if (S.rendered.get(i) !== entry) return;
  entry.textDivs = tl.textDivs;
  entry.textStrs = tc.items.map((it) => it.str);
  paintHighlights(i);
}

async function addLinks(page, el, vp, entry) {
  let anns;
  try { anns = await page.getAnnotations({ intent: 'display' }); } catch { return; }
  if (S.rendered.get(+el.dataset.page - 1) !== entry) return;
  const links = anns.filter((a) => a.subtype === 'Link' && Array.isArray(a.rect) && (a.dest || a.url));
  if (!links.length) return;
  const layer = document.createElement('div');
  layer.className = 'linkLayer';
  for (const a of links) {
    const r = vp.convertToViewportRectangle(a.rect);
    const x = Math.min(r[0], r[2]);
    const y = Math.min(r[1], r[3]);
    const link = document.createElement('a');
    link.className = 'pdfLink';
    link.style.left = x + 'px';
    link.style.top = y + 'px';
    link.style.width = Math.abs(r[2] - r[0]) + 'px';
    link.style.height = Math.abs(r[3] - r[1]) + 'px';
    link.href = '#';
    if (a.url) {
      link.title = String(a.url).slice(0, 300);
      link.addEventListener('click', (e) => { e.preventDefault(); if (C.isSafeExternalUrl(a.url)) post({ type: 'openExternal', url: a.url }); });
    } else {
      link.title = 'Go to destination';
      link.addEventListener('click', (e) => { e.preventDefault(); goToDest(a.dest); });
    }
    layer.appendChild(link);
  }
  el.appendChild(layer);
}

// ---------- search ----------
function focusSearch() {
  const box = $('searchInput');
  box.focus();
  box.select();
}

let searchTimer = null;
function onSearchInput() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => startSearch($('searchInput').value, false), 250);
}

async function startSearch(query, keepSelection) {
  const id = ++S.search.id;
  S.search.query = query;
  S.search.matches = [];
  S.search.byPage = new Map();
  S.search.total = 0;
  S.search.done = false;
  const prevSel = keepSelection ? S.search.selected : -1;
  S.search.selected = -1;
  repaintAllHighlights();
  updateSearchUi();
  if (!query.trim() || !S.doc) { S.search.done = true; updateSearchUi(); return; }
  const opts = { caseSensitive: !!S.config.searchCaseSensitive || $('caseBtn').getAttribute('aria-pressed') === 'true' };
  const start = S.page - 1;
  let jumped = false;
  for (let i = 0; i < S.numPages; i++) {
    if (id !== S.search.id) return;
    const { items } = await getTextItems(i);
    if (id !== S.search.id) return;
    const found = C.findInPage(items, query, opts);
    const list = [];
    for (let k = 0; k < found.length; k++) { const m = { page: i, idx: k, parts: found[k].parts }; S.search.matches.push(m); list.push(m); }
    if (list.length) S.search.byPage.set(i, list);
    S.search.total = S.search.matches.length;
    if (found.length) paintHighlights(i);
    if (!jumped && found.length && i >= start) {
      jumped = true;
      const sel = prevSel >= 0 && prevSel < S.search.total ? prevSel : S.search.matches.length - found.length;
      selectMatch(sel);
    }
    if (i % 20 === 19) { updateSearchUi(); await new Promise((r) => setTimeout(r, 0)); }
  }
  S.search.done = true;
  if (!jumped && S.search.total) selectMatch(0);
  updateSearchUi();
}

function stepMatch(dir) {
  const n = S.search.total;
  if (!n) return;
  const cur = S.search.selected < 0 ? (dir > 0 ? -1 : 0) : S.search.selected;
  selectMatch((cur + dir + n) % n);
}

function selectMatch(k) {
  const prev = S.search.matches[S.search.selected];
  S.search.selected = k;
  const m = S.search.matches[k];
  if (prev) paintHighlights(prev.page);
  updateSearchUi();
  if (!m) return;
  paintHighlights(m.page);
  revealMatch(m);
}

function revealMatch(m) {
  const el = S.pageEls[m.page];
  const v = $('viewer');
  const span = el && el.querySelector('.textLayer .highlight.selected');
  if (span) {
    const sr = span.getBoundingClientRect();
    const vr = v.getBoundingClientRect();
    if (sr.top < vr.top + 40 || sr.bottom > vr.bottom - 20) v.scrollTop += sr.top - vr.top - v.clientHeight / 3;
    return;
  }
  // Page not rendered yet: go there, the highlight shows when its text layer is ready.
  scrollToPage(m.page + 1, null, 0);
  S.revealAfterRender = m;
}

function repaintAllHighlights() {
  S.rendered.forEach((_, i) => paintHighlights(i));
}

function paintHighlights(i) {
  const r = S.rendered.get(i);
  if (!r || !r.textDivs) return;
  const sel = S.search.matches[S.search.selected];
  const byItem = new Map();
  for (const m of S.search.byPage.get(i) || []) {
    const cls = sel === m ? 'highlight selected' : 'highlight';
    for (const p of m.parts) {
      if (!byItem.has(p.item)) byItem.set(p.item, []);
      byItem.get(p.item).push({ from: p.from, to: p.to, cls });
    }
  }
  r.textDivs.forEach((div, idx) => {
    const str = r.textStrs[idx] || '';
    const ranges = byItem.get(idx);
    if (!ranges) {
      if (div.dataset.hl) { div.textContent = str; delete div.dataset.hl; }
      return;
    }
    const frag = document.createDocumentFragment();
    for (const seg of C.segments(str, ranges)) {
      if (!seg.cls) frag.appendChild(document.createTextNode(seg.text));
      else {
        const s = document.createElement('span');
        s.className = seg.cls;
        s.textContent = seg.text;
        frag.appendChild(s);
      }
    }
    div.replaceChildren(frag);
    div.dataset.hl = '1';
  });
  if (S.revealAfterRender && S.revealAfterRender.page === i && sel === S.revealAfterRender) {
    S.revealAfterRender = null;
    requestAnimationFrame(() => revealMatch(sel));
  }
}

function updateSearchUi() {
  const n = S.search.total;
  const q = S.search.query.trim();
  let txt = '';
  if (q) {
    if (!n) txt = S.search.done ? 'No results' : 'Searching…';
    else txt = (S.search.selected + 1) + ' of ' + n + (S.search.done ? '' : '+');
  }
  $('searchCount').textContent = txt;
  $('searchInput').classList.toggle('noResults', !!q && S.search.done && !n);
}

// ---------- outline ----------
async function loadOutline(myId) {
  let outline = null;
  try { outline = await S.doc.getOutline(); } catch { outline = null; }
  if (myId !== S.docId) return;
  const tree = C.flattenOutline(outline || []);
  const box = $('outline');
  box.replaceChildren();
  if (!tree.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'This PDF has no outline.';
    box.appendChild(p);
    if (!$('sidebar').dataset.userTab) showTab('thumbs');
    return;
  }
  box.appendChild(renderOutline(tree));
  if (!$('sidebar').dataset.userTab) showTab('outline');
}

function renderOutline(nodes) {
  const ul = document.createElement('ul');
  ul.setAttribute('role', 'group');
  for (const n of nodes) {
    const li = document.createElement('li');
    li.setAttribute('role', 'treeitem');
    const row = document.createElement('div');
    row.className = 'outlineRow';
    row.style.paddingLeft = 4 + Math.min(n.depth, 12) * 12 + 'px';
    const twisty = document.createElement('button');
    twisty.className = 'twisty';
    twisty.tabIndex = -1;
    if (n.children.length) {
      twisty.textContent = '▾';
      twisty.setAttribute('aria-label', 'Collapse');
      twisty.addEventListener('click', (e) => {
        e.stopPropagation();
        const collapsed = li.classList.toggle('collapsed');
        twisty.textContent = collapsed ? '▸' : '▾';
        twisty.setAttribute('aria-label', collapsed ? 'Expand' : 'Collapse');
      });
    } else twisty.classList.add('leaf');
    const a = document.createElement('a');
    a.href = '#';
    a.textContent = n.title;
    a.title = n.title;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      if (n.dest != null) goToDest(n.dest);
      else if (n.url && C.isSafeExternalUrl(n.url)) post({ type: 'openExternal', url: n.url });
    });
    row.append(twisty, a);
    li.appendChild(row);
    if (n.children.length) li.appendChild(renderOutline(n.children));
    ul.appendChild(li);
  }
  return ul;
}

async function goToDest(dest) {
  if (!S.doc) return;
  try {
    const t = await C.resolveDest(dest, (name) => S.doc.getDestination(name), (ref) => S.doc.getPageIndex(ref));
    if (t && t.pageIndex >= 0 && t.pageIndex < S.numPages) { scrollToPage(t.pageIndex + 1, t.top); saveState(); }
  } catch (e) { console.error(e); }
}

// ---------- thumbnails ----------
function buildThumbs() {
  const box = $('thumbs');
  box.replaceChildren();
  if (S.thumbsObserver) S.thumbsObserver.disconnect();
  S.thumbsObserver = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) renderThumb(+e.target.dataset.index).catch(renderErr);
  }, { root: box, rootMargin: '300px' });
  const frag = document.createDocumentFragment();
  for (let i = 0; i < S.numPages; i++) {
    const t = document.createElement('button');
    t.className = 'thumb';
    t.dataset.index = String(i);
    t.title = 'Page ' + (i + 1);
    const ratio = S.sizes[i].height / S.sizes[i].width;
    const holder = document.createElement('div');
    holder.className = 'thumbImg';
    holder.style.height = Math.round(110 * ratio) + 'px';
    const label = document.createElement('span');
    label.textContent = String(i + 1);
    t.append(holder, label);
    t.addEventListener('click', () => { scrollToPage(i + 1); saveState(); });
    frag.appendChild(t);
    S.thumbsObserver.observe(t);
  }
  box.appendChild(frag);
  updateThumbSelection();
}

async function renderThumb(i) {
  if (S.thumbsRendered.has(i) || !S.doc || $('sidebar').hidden) return;
  S.thumbsRendered.add(i);
  const docId = S.docId;
  const page = await S.doc.getPage(i + 1);
  const scale = 110 / page.getViewport({ scale: 1 }).width;
  const dark = isDarkNow();
  const canvas = document.createElement('canvas');
  const { vp, os, task } = await drawPage(page, canvas, scale, dark);
  await task.promise;
  if (docId !== S.docId) return;
  if (dark) {
    const rects = S.config.keepImagesInDarkMode ? await pageImageRects(page, i) : [];
    darkenCanvas(canvas, C.toCanvasRects(rects, C.multiply([os, 0, 0, os, 0, 0], vp.transform), canvas.width, canvas.height));
  }
  const holder = $('thumbs').children[i] && $('thumbs').children[i].querySelector('.thumbImg');
  if (holder) holder.replaceChildren(canvas);
}

function updateThumbSelection() {
  const box = $('thumbs');
  const cur = box.querySelector('.thumb.current');
  if (cur) cur.classList.remove('current');
  const t = box.children[S.page - 1];
  if (t) {
    t.classList.add('current');
    if (!$('sidebar').hidden && box.classList.contains('active')) {
      const tr = t.getBoundingClientRect();
      const br = box.getBoundingClientRect();
      if (tr.top < br.top || tr.bottom > br.bottom) box.scrollTop += tr.top - br.top - br.height / 3;
    }
  }
}

// ---------- sidebar ----------
function toggleSidebar(force) {
  const sb = $('sidebar');
  sb.hidden = typeof force === 'boolean' ? !force : !sb.hidden;
  $('sidebarBtn').setAttribute('aria-pressed', sb.hidden ? 'false' : 'true');
  vscode.setState(Object.assign({}, vscode.getState() || {}, { sidebar: !sb.hidden }));
  if (S.numPages) applyZoom(true);
  if (!sb.hidden && S.thumbsObserver) document.querySelectorAll('#thumbs .thumb').forEach((t) => { S.thumbsObserver.unobserve(t); S.thumbsObserver.observe(t); });
}
function showTab(name, byUser) {
  if (byUser) $('sidebar').dataset.userTab = '1';
  for (const t of ['outline', 'thumbs']) {
    $(t).classList.toggle('active', t === name);
    $(t).hidden = t !== name;
    $('tab-' + t).setAttribute('aria-selected', t === name ? 'true' : 'false');
  }
  if (name === 'thumbs') updateThumbSelection();
}

// ---------- toolbar ----------
function setZoom(z) {
  if (z == null) return;
  S.zoom = z;
  applyZoom(true);
  saveState();
}
function updateZoomUi() {
  const sel = $('zoomSelect');
  const custom = sel.querySelector('option[data-custom]');
  if (typeof S.zoom === 'string') sel.value = S.zoom;
  else {
    const v = String(S.zoom);
    if ([...sel.options].some((o) => o.value === v && !o.dataset.custom)) sel.value = v;
    else { custom.value = v; custom.textContent = Math.round(S.zoom * 100) + '%'; custom.hidden = false; sel.value = v; }
  }
}
function updatePageUi() {
  const inp = $('pageInput');
  if (document.activeElement !== inp) inp.value = String(S.page);
  updateThumbSelection();
}

function showMessage(title, text, actions) {
  const box = $('message');
  box.replaceChildren();
  const h = document.createElement('h2');
  h.textContent = title;
  const p = document.createElement('p');
  p.textContent = text;
  box.append(h, p);
  for (const a of actions || []) {
    const b = document.createElement('button');
    b.textContent = a.label;
    b.addEventListener('click', a.run);
    box.appendChild(b);
  }
  box.hidden = false;
  $('status').textContent = '';
}
function hideMessage() { $('message').hidden = true; }
function showError(e) {
  const msg = e && e.name === 'InvalidPDFException' ? 'This file is not a valid PDF, or it is damaged.' : String((e && e.message) || e);
  showMessage('Could not open this PDF', msg);
  post({ type: 'error', message: msg.slice(0, 500) });
}
function showTooLarge(size, limit) {
  const mb = (n) => (n / 1048576).toFixed(n >= 10 * 1048576 ? 0 : 1) + ' MB';
  showMessage('This PDF is large', 'The file is ' + mb(size) + '. The limit is ' + mb(limit) + ' (setting pdfViewer.maxFileSizeMB). Opening it can use a lot of memory.', [
    { label: 'Open anyway', run: () => { hideMessage(); $('status').textContent = 'Loading…'; post({ type: 'loadAnyway' }); } },
  ]);
}
function askPassword(update, reason) {
  const box = $('message');
  box.replaceChildren();
  const h = document.createElement('h2');
  h.textContent = 'This PDF is protected';
  const p = document.createElement('p');
  p.textContent = reason === 2 ? 'Wrong password. Try again.' : 'Enter the password to open it.';
  const form = document.createElement('form');
  const input = document.createElement('input');
  input.type = 'password';
  input.autocomplete = 'off';
  input.setAttribute('aria-label', 'Password');
  const b = document.createElement('button');
  b.type = 'submit';
  b.textContent = 'Open';
  form.append(input, b);
  form.addEventListener('submit', (e) => { e.preventDefault(); box.hidden = true; update(input.value); });
  box.append(h, p, form);
  box.hidden = false;
  input.focus();
}

function wireUi() {
  const v = $('viewer');
  v.addEventListener('scroll', scheduleRender, { passive: true });
  v.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey) || !S.numPages) return;
    e.preventDefault();
    setZoom(C.nextZoom(S.scale, e.deltaY < 0 ? 1 : -1));
  }, { passive: false });
  new ResizeObserver(() => { if (S.numPages && typeof S.zoom === 'string') applyZoom(true); }).observe(v);
  $('prevBtn').addEventListener('click', () => scrollToPage(S.page - 1));
  $('nextBtn').addEventListener('click', () => scrollToPage(S.page + 1));
  $('pageInput').addEventListener('change', () => { const n = parseInt($('pageInput').value, 10); if (n >= 1) { scrollToPage(n); saveState(); } });
  $('zoomOutBtn').addEventListener('click', () => setZoom(C.nextZoom(S.scale, -1)));
  $('zoomInBtn').addEventListener('click', () => setZoom(C.nextZoom(S.scale, 1)));
  $('zoomSelect').addEventListener('change', () => {
    const val = $('zoomSelect').value;
    setZoom(Number.isFinite(+val) ? C.clampScale(+val) : C.parseZoom(val));
  });
  $('darkBtn').addEventListener('click', toggleDark);
  $('sidebarBtn').addEventListener('click', () => toggleSidebar());
  $('tab-outline').addEventListener('click', () => showTab('outline', true));
  $('tab-thumbs').addEventListener('click', () => showTab('thumbs', true));
  $('searchInput').addEventListener('input', onSearchInput);
  $('searchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (S.search.query !== $('searchInput').value) startSearch($('searchInput').value); else stepMatch(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') { $('searchInput').value = ''; startSearch(''); v.focus(); }
  });
  $('searchPrev').addEventListener('click', () => stepMatch(-1));
  $('searchNext').addEventListener('click', () => stepMatch(1));
  $('caseBtn').addEventListener('click', () => {
    const on = $('caseBtn').getAttribute('aria-pressed') !== 'true';
    $('caseBtn').setAttribute('aria-pressed', on ? 'true' : 'false');
    startSearch($('searchInput').value);
  });
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const inInput = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
    if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); focusSearch(); return; }
    if (e.key === 'F3') { e.preventDefault(); stepMatch(e.shiftKey ? -1 : 1); return; }
    // Ctrl/Cmd + and - are contributed keybindings (package.json). VS Code forwards every webview keydown
    // to the workbench, so handling them here too would zoom twice, or zoom the whole window.
    if (inInput) return;
    if (e.key === 'ArrowRight' && !mod) { e.preventDefault(); scrollToPage(S.page + 1); }
    else if (e.key === 'ArrowLeft' && !mod) { e.preventDefault(); scrollToPage(S.page - 1); }
    else if (e.key === 'Home' && !mod) { e.preventDefault(); scrollToPage(1); }
    else if (e.key === 'End' && !mod) { e.preventDefault(); scrollToPage(S.numPages); }
  });
  new MutationObserver(() => { if (S.darkOverride == null) onDarkChanged(); })
    .observe(document.body, { attributes: true, attributeFilter: ['class', 'data-vscode-theme-kind'] });
  const st = vscode.getState();
  if (st && st.sidebar) toggleSidebar(true);
  applyDarkClass();
}

wireUi();
post({ type: 'ready' });
