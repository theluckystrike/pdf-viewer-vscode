'use strict';
// Highlights the user makes in a PDF. They are kept in VS Code's local storage (globalState), per file,
// and never written into the PDF. Pure logic over a get/update interface so it can be tested without VS Code.

const { markdownPageLink } = require('./protocol');

const KEY = 'pdfViewer.highlights.v1';
const MAX_FILES = 300;
const MAX_PER_FILE = 1000;
const MAX_RECTS = 200;
const MAX_TEXT = 2000;
const COLORS = ['yellow', 'green', 'blue', 'pink'];
const ID = /^[A-Za-z0-9_-]{1,40}$/;

const unit = (n) => typeof n === 'number' && isFinite(n) && n >= -0.001 && n <= 1.001;

/** One clean highlight, or null. Input comes from the webview, so every field is checked. */
function sanitizeHighlight(h) {
  if (!h || typeof h !== 'object') return null;
  if (typeof h.id !== 'string' || !ID.test(h.id)) return null;
  if (!Number.isInteger(h.page) || h.page < 1 || h.page > 1e6) return null;
  if (!Array.isArray(h.rects) || !h.rects.length) return null;
  const rects = [];
  for (const r of h.rects.slice(0, MAX_RECTS)) {
    if (!Array.isArray(r) || r.length !== 4 || !r.every(unit)) continue;
    if (!(r[2] > 0) || !(r[3] > 0)) continue;
    rects.push(r.map((n) => Math.round(Math.min(1, Math.max(0, n)) * 1e5) / 1e5));
  }
  if (!rects.length) return null;
  const text = typeof h.text === 'string' ? h.text.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, MAX_TEXT) : '';
  const color = COLORS.includes(h.color) ? h.color : 'yellow';
  const created = Number.isFinite(h.created) && h.created > 0 ? Math.floor(h.created) : 0;
  return { id: h.id, page: h.page, rects, text, color, created };
}

/** A clean list: bad entries and duplicate ids dropped, at most MAX_PER_FILE, sorted by page and position. */
function sanitizeHighlights(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const h of list) {
    const c = sanitizeHighlight(h);
    if (!c || seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
    if (out.length >= MAX_PER_FILE) break;
  }
  return sortHighlights(out);
}

function sortHighlights(list) {
  return list.slice().sort((a, b) => a.page - b.page || a.rects[0][1] - b.rects[0][1] || a.rects[0][0] - b.rects[0][0]);
}

/**
 * Highlights as a Markdown list. Each line quotes the text and links to its page, so a click in the
 * Markdown preview opens the PDF there. file: { fileName, relPath, fileUri }.
 */
function highlightsToMarkdown(file, list) {
  const items = sortHighlights(list || []);
  const lines = [`## Highlights in ${file.fileName}`, ''];
  if (!items.length) lines.push('No highlights yet.');
  for (const h of items) {
    const link = markdownPageLink(Object.assign({}, file, { page: h.page })).replace(/^\[[^\]]*\]/, `[page ${h.page}]`);
    const text = h.text ? h.text.replace(/\s+/g, ' ').trim() : '(no text)';
    lines.push(`- "${text}" (${link})`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Zovo Pro: the highlights of many PDFs as one Markdown file. files: [{ fileName, relPath, fileUri, items }]
 * (relPath null outside the workspace). Grouped by file (sorted by path), each line with its color and page link.
 */
function allHighlightsToMarkdown(files, opts) {
  const o = opts || {};
  const list = (files || []).filter((f) => f && Array.isArray(f.items) && f.items.length);
  const label = (f) => (f.relPath != null ? f.relPath : f.fileName);
  list.sort((a, b) => label(a).localeCompare(label(b)));
  const total = list.reduce((n, f) => n + f.items.length, 0);
  const lines = ['# PDF highlights', ''];
  const when = o.date ? ' on ' + o.date : '';
  lines.push(total + ' highlight' + (total === 1 ? '' : 's') + ' in ' + list.length + ' PDF' + (list.length === 1 ? '' : 's') + when + '. Each line links to its page.', '');
  for (const f of list) {
    const title = f.relPath != null ? f.relPath : f.fileName;
    lines.push('## ' + title.replace(/[\\`*_#\[\]<>]/g, (c) => '\\' + c), '');
    for (const h of sortHighlights(f.items)) {
      const link = markdownPageLink({ fileName: f.fileName, relPath: f.relPath, fileUri: f.fileUri, page: h.page }).replace(/^\[[^\]]*\]/, '[page ' + h.page + ']');
      const text = h.text ? h.text.replace(/\s+/g, ' ').trim() : '(no text)';
      lines.push('- "' + text + '" (' + link + ', ' + h.color + ')');
    }
    lines.push('');
  }
  if (!list.length) lines.push('No highlights yet.', '');
  return lines.join('\n');
}

class HighlightStore {
  constructor(memento, maxFiles) {
    this.memento = memento;
    this.max = maxFiles || MAX_FILES;
  }
  _all() {
    const v = this.memento.get(KEY);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  }
  get(uri) {
    const e = this._all()[String(uri)];
    return e && Array.isArray(e.items) ? sanitizeHighlights(e.items) : [];
  }
  async set(uri, items) {
    const all = this._all();
    const key = String(uri);
    delete all[key];
    const clean = sanitizeHighlights(items);
    if (clean.length) all[key] = { items: clean, t: Date.now() };
    const keys = Object.keys(all);
    if (keys.length > this.max) {
      keys.sort((a, b) => (all[a].t || 0) - (all[b].t || 0));
      for (const k of keys.slice(0, keys.length - this.max)) delete all[k];
    }
    await this.memento.update(KEY, all);
    return clean;
  }
  /** Every file with highlights: [{ key, items, t }], newest first. */
  entries() {
    const all = this._all();
    return Object.keys(all)
      .map((key) => ({ key, items: all[key] && Array.isArray(all[key].items) ? sanitizeHighlights(all[key].items) : [], t: (all[key] && all[key].t) || 0 }))
      .filter((e) => e.items.length)
      .sort((a, b) => b.t - a.t);
  }
  count() {
    return Object.values(this._all()).reduce((n, e) => n + (Array.isArray(e.items) ? e.items.length : 0), 0);
  }
  async clear() {
    await this.memento.update(KEY, undefined);
  }
}

module.exports = { HighlightStore, sanitizeHighlight, sanitizeHighlights, highlightsToMarkdown, allHighlightsToMarkdown, KEY, COLORS, MAX_PER_FILE };
