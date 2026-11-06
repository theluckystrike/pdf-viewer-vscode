'use strict';
// Runs inside the VS Code extension host. Opens sample.pdf in the custom editor and waits until the
// real webview has loaded pdf.js, parsed the file and drawn the first page.
const vscode = require('vscode');
const path = require('path');

async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 200)); }
  return null;
}

exports.run = async function run() {
  const ext = vscode.extensions.getExtension('zovo.pdf-viewer-dark');
  if (!ext) throw new Error('extension not found');
  const file = vscode.Uri.file(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'sample.pdf'));
  // plain open: the custom editor is the default for *.pdf
  await vscode.commands.executeCommand('vscode.open', file);
  const api = await ext.activate();
  const entry = await waitFor(() => [...api.provider.panels].find((e) => e.firstRender), 30000);
  if (!entry) throw new Error('webview did not render a page within 30 s. panels=' + JSON.stringify([...api.provider.panels].map((e) => ({ ready: e.ready, pages: e.pages, error: e.lastError }))));
  console.log('IT PASS webview ready, pages =', entry.pages, ', first render =', JSON.stringify(entry.firstRender));
  if (entry.pages !== 4) throw new Error('expected 4 pages, got ' + entry.pages);
  if (entry.firstRender.dark !== true) throw new Error('expected dark pages under Default Dark Modern');
  // palette command reaches the webview and dark mode toggles off: next render reports dark=false
  entry.firstRender = null;
  await vscode.commands.executeCommand('pdfViewer.toggleDarkMode');
  const light = await waitFor(() => entry.firstRender, 15000);
  if (!light || light.dark !== false) throw new Error('toggle did not re-render light pages: ' + JSON.stringify(light));
  console.log('IT PASS palette toggle re-rendered pages light');

  // Zoom command -> webview zooms -> webview reports state -> host remembers page and zoom for this file.
  const before = api.provider.store.get(file.toString());
  await vscode.commands.executeCommand('pdfViewer.zoomIn');
  const saved = await waitFor(() => { const st = api.provider.store.get(file.toString()); return st && typeof st.zoom === 'number' ? st : null; }, 10000);
  if (!saved) throw new Error('zoom state not remembered, before=' + JSON.stringify(before));
  console.log('IT PASS zoom command applied and remembered:', JSON.stringify(saved));

  // Reload on change: rewrite the file on disk and wait for the webview to load it again.
  entry.pages = null;
  const fs = require('fs');
  fs.writeFileSync(file.fsPath, fs.readFileSync(file.fsPath));
  const reloaded = await waitFor(() => entry.pages === 4, 15000);
  if (!reloaded) throw new Error('no reload after the file changed on disk');
  console.log('IT PASS reloaded after the file changed on disk');

  // R7 P3: hide the tab (another editor in the same group), then show it again. The webview frees its
  // canvases while hidden and reports a fresh render when it is back.
  entry.firstRender = null;
  await vscode.commands.executeCommand('workbench.action.files.newUntitledFile');
  const hidden = await waitFor(() => entry.visible === false, 10000);
  if (!hidden) throw new Error('host did not see the tab hidden');
  await new Promise((r) => setTimeout(r, 500));
  if (entry.firstRender) throw new Error('hidden tab rendered pages: ' + JSON.stringify(entry.firstRender));
  await vscode.commands.executeCommand('vscode.open', file);
  const redrawn = await waitFor(() => entry.visible === true && entry.firstRender, 15000);
  if (!redrawn) throw new Error('no redraw after the tab was shown again');
  console.log('IT PASS hidden tab freed pages and redrew when shown:', JSON.stringify(redrawn));

  // R7 P2: a file name with glob characters still reloads when it changes on disk.
  const odd = vscode.Uri.file(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'paper[1] {v2}.pdf'));
  await vscode.commands.executeCommand('vscode.open', odd);
  const e2 = await waitFor(() => [...api.provider.panels].find((e) => e.uri.toString() === odd.toString() && e.pages === 4), 30000);
  if (!e2) throw new Error('paper[1] {v2}.pdf did not load');
  await new Promise((r) => setTimeout(r, 1000));
  e2.pages = null;
  fs.writeFileSync(odd.fsPath, fs.readFileSync(odd.fsPath));
  const oddReloaded = await waitFor(() => e2.pages === 4, 15000);
  if (!oddReloaded) throw new Error('no reload for a file named with glob characters');
  console.log('IT PASS reloaded paper[1] {v2}.pdf after it changed on disk');
};
