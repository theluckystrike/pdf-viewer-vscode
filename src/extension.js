'use strict';
const vscode = require('vscode');
const path = require('path');
const { buildHtml } = require('./html');
const { parseWebviewMessage, readConfig, parsePdfFragment, markdownPageLink } = require('./protocol');
const { StateStore } = require('./stateStore');
const { HighlightStore, highlightsToMarkdown } = require('./highlights');
const { watchGlob, isSameFile } = require('./watch');
const { createRatingPrompt } = require('./rate');
const { registerSupport, commandUris, showLinks } = require('./support');

let rating = { success() {}, failure() {} };

const VIEW_TYPE = 'pdfViewer.preview';
const CONFIG = 'pdfViewer';
const SIDEBAR_KEY = 'pdfViewer.sidebarOpen.v1';

/** The file without a `#page=4` style fragment, so positions are remembered per file, not per link. */
function fileKey(uri) {
  return uri.fragment && typeof uri.with === 'function' ? uri.with({ fragment: '' }).toString() : uri.toString().split('#')[0];
}

/**
 * readFile returns a Node Buffer in the desktop extension host. VS Code serialises a Buffer to JSON
 * ({type: 'Buffer', data: [...]}) instead of transferring it, so copy it into a plain Uint8Array,
 * which postMessage sends as raw bytes. Small Buffers also share a pooled ArrayBuffer; the copy avoids
 * sending the whole pool.
 */
function toPlainBytes(data) {
  if (Object.getPrototypeOf(data) === Uint8Array.prototype && data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) return data;
  const out = new Uint8Array(data.byteLength);
  out.set(data);
  return out;
}

class PdfDocument {
  constructor(uri) { this.uri = uri; }
  dispose() {}
}

class PdfEditorProvider {
  constructor(context) {
    this.context = context;
    this.store = new StateStore(context.globalState);
    this.highlights = new HighlightStore(context.globalState);
    this.panels = new Set();
    this.active = null;
  }

  openCustomDocument(uri) {
    return new PdfDocument(uri);
  }

  config() {
    const c = vscode.workspace.getConfiguration(CONFIG);
    return readConfig((k, d) => c.get(k, d));
  }

  async resolveCustomEditor(document, panel) {
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const webview = panel.webview;
    // Command links are limited to the two support commands and the settings page (footer "Hide" link).
    webview.options = { enableScripts: true, localResourceRoots: [media], enableCommandUris: commandUris('pdfViewer') };
    const u = (...p) => webview.asWebviewUri(vscode.Uri.joinPath(media, ...p)).toString();
    webview.html = buildHtml({
      core: u('core.js'),
      viewer: u('viewer.js'),
      css: u('viewer.css'),
      pdfjs: u('pdfjs', 'pdf.min.mjs'),
      worker: u('pdfjs', 'pdf.worker.min.mjs'),
      cmaps: u('pdfjs', 'cmaps') + '/',
      fonts: u('pdfjs', 'standard_fonts') + '/',
      wasm: u('pdfjs', 'wasm') + '/',
    }, webview.cspSource, undefined, { showSupportLinks: showLinks(vscode, 'pdfViewer') });

    const entry = { panel, uri: document.uri, ready: false, forceLoad: false, visible: true, page: 1 };
    const key = fileKey(document.uri);
    // `report.pdf#page=4` from a Markdown link: open at that page once, then behave as usual.
    let target = parsePdfFragment(document.uri.fragment);
    this.panels.add(entry);
    if (panel.active) this.active = entry;
    const disposables = [];

    const send = (msg) => webview.postMessage(msg);
    const load = async (reload) => {
      try {
        const cfg = this.config();
        const stat = await vscode.workspace.fs.stat(document.uri);
        if (stat.size > cfg.maxFileSizeBytes && !entry.forceLoad) {
          send({ type: 'tooLarge', size: stat.size, limit: cfg.maxFileSizeBytes });
          return;
        }
        const data = await vscode.workspace.fs.readFile(document.uri);
        if (panelDisposed) return;
        send({ type: 'load', data: toPlainBytes(data), reload });
      } catch (e) {
        rating.failure();
        send({ type: 'error', message: e && e.message ? e.message : String(e), reload: !!reload });
      }
    };

    let panelDisposed = false;
    // A hidden tab keeps its webview (retainContextWhenHidden), so tell it to free its page canvases,
    // and to draw the visible pages again when the tab comes back.
    const syncVisibility = () => {
      const visible = panel.visible !== false;
      if (entry.ready && visible !== entry.visible) {
        entry.visible = visible;
        send({ type: 'visibility', visible });
      }
    };
    disposables.push(webview.onDidReceiveMessage((raw) => {
      const m = parseWebviewMessage(raw);
      if (!m) return;
      if (m.type === 'ready') {
        entry.ready = true;
        entry.visible = true; // a fresh webview starts out drawing pages
        const cfg = this.config();
        send({
          type: 'init',
          config: cfg,
          state: cfg.rememberPage ? this.store.get(key) : null,
          target,
          sidebarOpen: this.sidebarDefault(cfg),
          fileName: path.basename(document.uri.path),
          highlights: this.highlights.get(key),
        });
        target = null; // a webview reload (hidden tab, window reload) keeps its own position
        load(false);
        syncVisibility();
      } else if (m.type === 'error') {
        entry.lastError = m.message;
        rating.failure();
      } else if (m.type === 'info') {
        entry.pages = m.pages;
        if (!entry.counted) { entry.counted = true; rating.success(); }
      } else if (m.type === 'rendered') {
        entry.firstRender = { page: m.page, dark: m.dark };
      } else if (m.type === 'loadAnyway') {
        entry.forceLoad = true;
        load(false);
      } else if (m.type === 'state') {
        entry.page = m.page;
        if (this.config().rememberPage) this.store.set(key, m.page, m.zoom);
      } else if (m.type === 'sidebar') {
        entry.sidebarOpen = m.open;
        if (this.config().sidebar === 'remember') this.context.globalState.update(SIDEBAR_KEY, m.open);
      } else if (m.type === 'highlights') {
        this.highlights.set(key, m.items).then(() => this.syncHighlights(entry, key, m.items));
      } else if (m.type === 'copyHighlights') {
        this.copyHighlights(entry);
      } else if (m.type === 'openExternal') {
        // Only after a user click on a link inside the PDF, and only http, https and mailto (checked in protocol.js).
        vscode.env.openExternal(vscode.Uri.parse(m.url, true));
      }
    }));

    // Reload when the file changes on disk (also for files outside the workspace).
    let timer = null;
    const fileName = path.posix.basename(document.uri.path);
    const onChange = (changed) => {
      if (!isSameFile(changed, fileName)) return;
      clearTimeout(timer);
      timer = setTimeout(() => { if (entry.ready) load(true); }, 300);
    };
    const dir = vscode.Uri.joinPath(document.uri, '..');
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, watchGlob(fileName)));
    disposables.push(watcher, watcher.onDidChange(onChange), watcher.onDidCreate(onChange));

    disposables.push(vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(CONFIG) && entry.ready) send({ type: 'config', config: this.config() });
    }));
    disposables.push(panel.onDidChangeViewState(() => {
      if (panel.active) this.active = entry;
      else if (this.active === entry) this.active = null;
      vscode.commands.executeCommand('setContext', 'pdfViewer.active', !!this.active);
      syncVisibility();
    }));
    vscode.commands.executeCommand('setContext', 'pdfViewer.active', !!this.active);
    panel.onDidDispose(() => {
      panelDisposed = true;
      clearTimeout(timer);
      this.panels.delete(entry);
      if (this.active === entry) this.active = null;
      vscode.commands.executeCommand('setContext', 'pdfViewer.active', !!this.active);
      disposables.forEach((d) => d.dispose());
    });
  }

  /** Whether a newly opened PDF shows the outline and pages sidebar (setting pdfViewer.sidebar). */
  sidebarDefault(cfg) {
    if (cfg.sidebar === 'open') return true;
    if (cfg.sidebar === 'remember') return this.context.globalState.get(SIDEBAR_KEY) === true;
    return false;
  }

  /** Other open views of the same file show the same highlights. */
  syncHighlights(from, key, items) {
    for (const e of this.panels) {
      if (e !== from && e.ready && fileKey(e.uri) === key) e.panel.webview.postMessage({ type: 'highlights', items });
    }
  }

  fileInfo(entry) {
    const uri = entry.uri.fragment && typeof entry.uri.with === 'function' ? entry.uri.with({ fragment: '' }) : entry.uri;
    const folder = vscode.workspace.getWorkspaceFolder ? vscode.workspace.getWorkspaceFolder(uri) : undefined;
    const relPath = folder ? path.posix.relative(folder.uri.path, uri.path) : null;
    return { fileName: path.posix.basename(uri.path), relPath, fileUri: uri.toString() };
  }

  /** Copies the highlights of a PDF as a Markdown list with a link to each page. */
  async copyHighlights(entry) {
    entry = entry || this.active;
    if (!entry) return;
    const items = this.highlights.get(fileKey(entry.uri));
    if (!items.length) {
      vscode.window.showInformationMessage('This PDF has no highlights yet. Select text in the PDF and click Highlight, or press H.');
      return '';
    }
    const md = highlightsToMarkdown(this.fileInfo(entry), items);
    await vscode.env.clipboard.writeText(md);
    vscode.window.showInformationMessage(`Copied ${items.length} highlight${items.length === 1 ? '' : 's'} as Markdown. Each one links to its page.`);
    return md;
  }

  sendCommand(name) {
    if (this.active) this.active.panel.webview.postMessage({ type: 'command', name });
  }

  async goToPage() {
    const entry = this.active;
    if (!entry) return;
    const max = entry.pages || 0;
    const value = await vscode.window.showInputBox({
      title: 'Go to page',
      prompt: max ? `Page number, 1 to ${max}` : 'Page number',
      value: String(entry.page || 1),
      validateInput: (v) => {
        const n = Number(v.trim());
        if (!Number.isInteger(n) || n < 1) return 'Type a page number.';
        if (max && n > max) return `This PDF has ${max} pages.`;
        return null;
      },
    });
    if (value == null || !this.panels.has(entry)) return;
    entry.panel.webview.postMessage({ type: 'goTo', page: Number(value.trim()) });
  }

  async copyPageLink() {
    const entry = this.active;
    if (!entry) return;
    const uri = entry.uri.fragment && typeof entry.uri.with === 'function' ? entry.uri.with({ fragment: '' }) : entry.uri;
    const folder = vscode.workspace.getWorkspaceFolder ? vscode.workspace.getWorkspaceFolder(uri) : undefined;
    const relPath = folder ? path.posix.relative(folder.uri.path, uri.path) : null;
    const link = markdownPageLink({ fileName: path.posix.basename(uri.path), relPath, fileUri: uri.toString(), page: entry.page || 1 });
    await vscode.env.clipboard.writeText(link);
    vscode.window.showInformationMessage(`Copied a Markdown link to page ${entry.page || 1}. Paste it in a .md file and click it to open the PDF at that page.`);
    return link;
  }
}

function activate(context) {
  rating = createRatingPrompt({ vscode, context, extensionId: 'zovo.pdf-viewer-dark', section: 'pdfViewer', name: 'PDF Viewer' });
  registerSupport({ vscode, context, prefix: 'pdfViewer', selfId: 'zovo.pdf-viewer-dark' });
  const provider = new PdfEditorProvider(context);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    })
  );
  const cmds = {
    'pdfViewer.toggleDarkMode': 'toggleDarkMode',
    'pdfViewer.find': 'find',
    'pdfViewer.zoomIn': 'zoomIn',
    'pdfViewer.zoomOut': 'zoomOut',
    'pdfViewer.fitWidth': 'fitWidth',
    'pdfViewer.fitPage': 'fitPage',
    'pdfViewer.toggleSidebar': 'toggleSidebar',
    'pdfViewer.toggleSepia': 'toggleSepia',
    'pdfViewer.highlightSelection': 'highlight',
    'pdfViewer.showHighlights': 'showHighlights',
  };
  for (const [id, name] of Object.entries(cmds)) {
    context.subscriptions.push(vscode.commands.registerCommand(id, () => provider.sendCommand(name)));
  }
  context.subscriptions.push(vscode.commands.registerCommand('pdfViewer.goToPage', () => provider.goToPage()));
  context.subscriptions.push(vscode.commands.registerCommand('pdfViewer.copyPageLink', () => provider.copyPageLink()));
  context.subscriptions.push(vscode.commands.registerCommand('pdfViewer.copyHighlights', () => provider.copyHighlights()));
  context.subscriptions.push(vscode.commands.registerCommand('pdfViewer.forgetPositions', async () => {
    await provider.store.clear();
    vscode.window.showInformationMessage('PDF Viewer: forgot the last page of every PDF.');
  }));
  context.subscriptions.push(vscode.commands.registerCommand('pdfViewer.openWith', async (uri) => {
    const target = uri instanceof vscode.Uri ? uri : (await vscode.window.showOpenDialog({ filters: { PDF: ['pdf'] }, canSelectMany: false }) || [])[0];
    if (target) await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
  }));
  return { provider };
}

function deactivate() {}

module.exports = { activate, deactivate, PdfEditorProvider, VIEW_TYPE, toPlainBytes, fileKey, SIDEBAR_KEY };
