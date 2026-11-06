'use strict';
// Remembers the last page and zoom per PDF. Backed by a vscode Memento (globalState), capped so it
// does not grow forever. Pure logic over a get/update interface so it can be tested without VS Code.

const KEY = 'pdfViewer.lastPositions.v1';
const MAX_ENTRIES = 500;

class StateStore {
  constructor(memento, max) {
    this.memento = memento;
    this.max = max || MAX_ENTRIES;
  }
  _all() {
    const v = this.memento.get(KEY);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  }
  get(uri) {
    const e = this._all()[String(uri)];
    if (!e || !Number.isInteger(e.page)) return null;
    return { page: e.page, zoom: e.zoom };
  }
  async set(uri, page, zoom) {
    const all = this._all();
    const key = String(uri);
    delete all[key]; // re-insert so it becomes the newest entry
    all[key] = { page, zoom, t: Date.now() };
    const keys = Object.keys(all);
    if (keys.length > this.max) {
      keys.sort((a, b) => (all[a].t || 0) - (all[b].t || 0));
      for (const k of keys.slice(0, keys.length - this.max)) delete all[k];
    }
    await this.memento.update(KEY, all);
  }
  async clear() {
    await this.memento.update(KEY, undefined);
  }
}

module.exports = { StateStore, KEY, MAX_ENTRIES };
