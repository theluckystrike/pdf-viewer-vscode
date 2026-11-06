'use strict';
// Serves the extension folder on 127.0.0.1 and a harness page that runs the real webview HTML
// (same CSP, same scripts) with a fake acquireVsCodeApi. Used by run.py for the browser test and screenshot.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { buildHtml } = require('../../src/html');

const root = path.join(__dirname, '..', '..');
const pdfArg = process.argv[2] || path.join(root, 'test', 'fixtures', 'sample.pdf');
const theme = process.argv[3] || 'dark';
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.pdf': 'application/pdf', '.wasm': 'application/wasm', '.html': 'text/html' };

const DARK_VARS = `--vscode-font-family:-apple-system,BlinkMacSystemFont,sans-serif;--vscode-font-size:13px;--vscode-foreground:#cccccc;--vscode-editor-background:#1f1f1f;--vscode-editorWidget-background:#202020;--vscode-sideBar-background:#181818;--vscode-editorGroup-border:#2b2b2b;--vscode-input-background:#313131;--vscode-input-foreground:#cccccc;--vscode-input-border:#3c3c3c;--vscode-dropdown-background:#313131;--vscode-dropdown-foreground:#cccccc;--vscode-focusBorder:#0078d4;--vscode-list-hoverBackground:#2a2d2e;--vscode-toolbar-hoverBackground:#5a5d5e50;--vscode-inputOption-activeBackground:#2489db82;--vscode-inputOption-activeBorder:#2488db;--vscode-button-background:#0078d4;--vscode-button-foreground:#ffffff`;
const LIGHT_VARS = `--vscode-font-family:-apple-system,BlinkMacSystemFont,sans-serif;--vscode-font-size:13px;--vscode-foreground:#3b3b3b;--vscode-editor-background:#ffffff;--vscode-editorWidget-background:#f8f8f8;--vscode-sideBar-background:#f8f8f8;--vscode-editorGroup-border:#e5e5e5;--vscode-input-background:#ffffff;--vscode-input-border:#cecece;--vscode-dropdown-background:#ffffff;--vscode-focusBorder:#005fb8;--vscode-list-hoverBackground:#f2f2f2;--vscode-inputOption-activeBackground:#bed6ed;--vscode-button-background:#005fb8;--vscode-button-foreground:#ffffff`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/harness.html') {
    const origin = 'http://' + req.headers.host;
    const N = 'testnonce123';
    const u = (p) => origin + '/media/' + p;
    let html = buildHtml({ core: u('core.js'), viewer: u('viewer.js'), css: u('viewer.css'), pdfjs: u('pdfjs/pdf.min.mjs'), worker: u('pdfjs/pdf.worker.min.mjs'), cmaps: u('pdfjs/cmaps/'), fonts: u('pdfjs/standard_fonts/'), wasm: u('pdfjs/wasm/') }, origin, N);
    const kind = theme === 'dark' ? 'vscode-dark' : 'vscode-light';
    const fake = `<script nonce="${N}">
window.__posted = [];
let __state = null;
window.acquireVsCodeApi = () => ({
  postMessage(m) { window.__posted.push(m); if (m.type === 'ready') {
    window.postMessage({ type: 'init', config: { darkMode: 'auto', keepImagesInDarkMode: true, defaultZoom: 'page-width' }, state: null, fileName: 'field-report.pdf' }, '*');
    fetch('/file.pdf').then(r => r.arrayBuffer()).then(b => window.postMessage({ type: 'load', data: new Uint8Array(b) }, '*'));
  } },
  getState() { return __state; }, setState(s) { __state = s; },
});
</script>`;
    html = html.replace('<body ', `<body class="${kind}" data-vscode-theme-kind="${kind}" `)
      .replace('</head>', `<style nonce="${N}">body{${theme === 'dark' ? DARK_VARS : LIGHT_VARS}}</style></head>`)
      .replace('<div id="toolbar"', fake + '\n<div id="toolbar"');
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(html);
  }
  const file = url.pathname === '/file.pdf' ? pdfArg : path.join(root, decodeURIComponent(url.pathname));
  if (!file.startsWith(root) && file !== pdfArg) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});
server.listen(0, '127.0.0.1', () => console.log(server.address().port));
