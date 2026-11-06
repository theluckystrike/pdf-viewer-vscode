'use strict';
const vscode = require('vscode');
const path = require('path');
const { buildHtml } = require('./html');
const { parseWebviewMessage, readConfig } = require('./protocol');
const { StateStore } = require('./stateStore');
const { watchGlob, isSameFile } = require('./watch');
const { createRatingPrompt } = require('./rate');
const { registerSupport, commandUris, showLinks } = require('./support');

let rating = { success() {} };

const VIEW_TYPE = 'pdfViewer.preview';
const CONFIG = 'pdfViewer';

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

    const entry = { panel, uri: document.uri, ready: false, forceLoad: false, visible: true };
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
        send({ type: 'error', message: e && e.message ? e.message : String(e) });
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
          state: cfg.rememberPage ? this.store.get(document.uri.toString()) : null,
          fileName: path.basename(document.uri.path),
        });
        load(false);
        syncVisibility();
      } else if (m.type === 'error') {
        entry.lastError = m.message;
      } else if (m.type === 'info') {
        entry.pages = m.pages;
        if (!entry.counted) { entry.counted = true; rating.success(); }
      } else if (m.type === 'rendered') {
        entry.firstRender = { page: m.page, dark: m.dark };
      } else if (m.type === 'loadAnyway') {
        entry.forceLoad = true;
        load(false);
      } else if (m.type === 'state') {
        if (this.config().rememberPage) this.store.set(document.uri.toString(), m.page, m.zoom);
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

  sendCommand(name) {
    if (this.active) this.active.panel.webview.postMessage({ type: 'command', name });
  }
}

function activate(context) {
  rating = createRatingPrompt({ vscode, context, extensionId: 'zovo.pdf-viewer-dark', section: 'pdfViewer', message: (n) => `PDF Viewer has opened ${n} files for you. A rating helps other people find it.` });
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
  };
  for (const [id, name] of Object.entries(cmds)) {
    context.subscriptions.push(vscode.commands.registerCommand(id, () => provider.sendCommand(name)));
  }
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

module.exports = { activate, deactivate, PdfEditorProvider, VIEW_TYPE, toPlainBytes };
