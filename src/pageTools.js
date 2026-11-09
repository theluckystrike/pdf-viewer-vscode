'use strict';
// Zovo Pro page tools and the all-highlights export (extension host side). The new PDF is written by pdf.js in the
// webview's worker (PDFDocumentProxy.extractPages, pdf.js 5.7); this file asks the user what to do, sends the plan,
// and writes the bytes it gets back with vscode.workspace.fs. No network.
const path = require('path');
const P = require('./pages');
const { allHighlightsToMarkdown } = require('./highlights');

const JOB_TIMEOUT_MS = 180000;
const MAX_MERGE_BYTES = 1024 * 1024 * 1024; // 1 GB of input in one merge

function createPageTools({ vscode, provider, pro, fileKey }) {
  let seq = 0;
  const pending = new Map(); // id -> { resolve, timer, entry }

  const say = (m, ...b) => vscode.window.showInformationMessage(m, ...b);
  const warn = (m) => vscode.window.showWarningMessage(m);
  const plain = (u) => (u.fragment && typeof u.with === 'function' ? u.with({ fragment: '' }) : u);
  const nameOf = (u) => path.posix.basename(u.path);
  const dirOf = (u) => vscode.Uri.joinPath(plain(u), '..');

  function activeEntry() {
    const e = provider.active || [...provider.panels].find((x) => x.panel && x.panel.visible);
    if (!e) { say('Open a PDF in PDF Viewer first.'); return null; }
    if (!e.pages) { say('The PDF is still loading. Try again in a moment.'); return null; }
    return e;
  }

  // Sends one job to the webview: plans (each one output file) and extra PDFs. Resolves { results, extraPages } or
  // { error }. A job that does not answer in JOB_TIMEOUT_MS fails, so the caller never waits for ever.
  function runJob(entry, plans, extras) {
    const id = ++seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { pending.delete(id); resolve({ error: 'PDF Viewer did not finish in time. Try fewer pages or smaller files.' }); }, JOB_TIMEOUT_MS);
      pending.set(id, { resolve, timer, entry });
      entry.panel.webview.postMessage({ type: 'pageOp', id, plans, extras: extras || [] });
    });
  }

  // Called by the provider for a 'pageOpResult' message (already checked by protocol.js).
  function onResult(entry, m) {
    const p = pending.get(m.id);
    if (!p || p.entry !== entry) return;
    pending.delete(m.id);
    clearTimeout(p.timer);
    p.resolve(m.error ? { error: m.error } : { results: m.results, extraPages: m.extraPages });
  }

  function onPanelClosed(entry) {
    for (const [id, p] of pending) if (p.entry === entry) { clearTimeout(p.timer); pending.delete(id); p.resolve({ error: 'The PDF was closed.' }); }
  }

  async function askPages(entry, title, prompt, value) {
    let parsed = null;
    const v = await vscode.window.showInputBox({
      title,
      prompt: prompt + ' This PDF has ' + entry.pages + ' page' + (entry.pages === 1 ? '' : 's') + '.',
      value: value || '',
      placeHolder: 'For example 1-3, 7, 10-',
      validateInput: (t) => { const r = P.parsePageList(t, entry.pages); return r.error || null; },
    });
    if (v == null) return null;
    parsed = P.parsePageList(v, entry.pages);
    return parsed.error ? null : parsed.segments;
  }

  async function writeAndReport(target, bytes, what) {
    await vscode.workspace.fs.writeFile(target, bytes);
    const pick = await say(what + ' Saved ' + nameOf(target) + '.', 'Open');
    if (pick === 'Open') await vscode.commands.executeCommand('vscode.openWith', target, 'pdfViewer.preview');
  }

  const bytesOk = (b) => b && typeof b.byteLength === 'number' && b.byteLength > 8;

  async function extract() {
    const entry = activeEntry();
    if (!entry || !(await pro.check('pages'))) return;
    const segs = await askPages(entry, 'Extract pages to a new PDF (Zovo Pro)', 'Pages to keep, in the order you want them.');
    if (!segs) return;
    const src = plain(entry.uri);
    const target = await vscode.window.showSaveDialog({
      title: 'Save the extracted pages as',
      defaultUri: vscode.Uri.joinPath(dirOf(src), P.baseName(nameOf(src)) + '-p' + P.rangeLabel(segs) + '.pdf'),
      filters: { PDF: ['pdf'] },
    });
    if (!target) return;
    const r = await runJob(entry, [P.extractPlan(segs)]);
    if (r.error || !r.results || !bytesOk(r.results[0])) return warn('Could not extract the pages: ' + (r.error || 'pdf.js returned no file.'));
    await writeAndReport(target, r.results[0], P.countPages(segs) + ' page' + (P.countPages(segs) === 1 ? '' : 's') + ' extracted.');
    await pro.commit('pages');
    return target;
  }

  async function remove() {
    const entry = activeEntry();
    if (!entry || !(await pro.check('pages'))) return;
    let left = null;
    const v = await vscode.window.showInputBox({
      title: 'Delete pages (Zovo Pro)',
      prompt: 'Pages to delete. The result is saved as a new PDF; you choose the name next. This PDF has ' + entry.pages + ' pages.',
      placeHolder: 'For example 2, 5-6',
      validateInput: (t) => { const r = P.parsePageList(t, entry.pages); if (r.error) return r.error; const d = P.deletePlan(r.segments, entry.pages); return d.error || null; },
    });
    if (v == null) return;
    const d = P.deletePlan(P.parsePageList(v, entry.pages).segments || [], entry.pages);
    if (d.error) return;
    left = d.left;
    const src = plain(entry.uri);
    const target = await vscode.window.showSaveDialog({
      title: 'Save the PDF without those pages as',
      defaultUri: vscode.Uri.joinPath(dirOf(src), P.baseName(nameOf(src)) + '-edited.pdf'),
      filters: { PDF: ['pdf'] },
    });
    if (!target) return;
    const r = await runJob(entry, [d.plan]);
    if (r.error || !r.results || !bytesOk(r.results[0])) return warn('Could not delete the pages: ' + (r.error || 'pdf.js returned no file.'));
    await writeAndReport(target, r.results[0], d.removed + ' page' + (d.removed === 1 ? '' : 's') + ' deleted, ' + left + ' left.');
    await pro.commit('pages');
    return target;
  }

  async function split() {
    const entry = activeEntry();
    if (!entry || !(await pro.check('pages'))) return;
    if (entry.pages < 2) return say('This PDF has one page. There is nothing to split.');
    const mode = await vscode.window.showQuickPick([
      { label: 'Every N pages', description: 'for example 10 pages per file', id: 'every' },
      { label: 'One file per page', description: entry.pages + ' files', id: 'each' },
      { label: 'At the ranges I type', description: 'for example 1-4, 5-9, 10-', id: 'at' },
    ], { title: 'Split PDF into several files (Zovo Pro)' });
    if (!mode) return;
    let res;
    if (mode.id === 'every') {
      const n = await vscode.window.showInputBox({
        title: 'Pages per file', prompt: 'This PDF has ' + entry.pages + ' pages.', value: String(Math.max(1, Math.ceil(entry.pages / 2))),
        validateInput: (t) => P.splitParts('every', entry.pages, Number(t.trim())).error || null,
      });
      if (n == null) return;
      res = P.splitParts('every', entry.pages, Number(n.trim()));
    } else if (mode.id === 'each') {
      res = P.splitParts('each', entry.pages);
    } else {
      const segs = await askPages(entry, 'Split at these ranges', 'One new file per range.');
      if (!segs) return;
      res = P.splitParts('at', entry.pages, segs);
    }
    if (res.error) return warn(res.error);
    const src = plain(entry.uri);
    const folder = await vscode.window.showOpenDialog({ title: 'Folder for the ' + res.parts.length + ' files', canSelectFiles: false, canSelectFolders: true, canSelectMany: false, defaultUri: dirOf(src), openLabel: 'Save here' });
    if (!folder || !folder[0]) return;
    const names = P.splitNames(nameOf(src), res.parts);
    const targets = names.map((n) => vscode.Uri.joinPath(folder[0], n));
    let existing = 0;
    for (const t of targets) { try { await vscode.workspace.fs.stat(t); existing++; } catch { /* free */ } }
    if (existing) {
      const ok = await vscode.window.showWarningMessage(existing + ' of the ' + targets.length + ' files already exist in that folder.', { modal: true }, 'Replace them');
      if (ok !== 'Replace them') return;
    }
    const plans = res.parts.map((p) => P.extractPlan([p]));
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Splitting ' + nameOf(src) + ' into ' + plans.length + ' files' }, () => runJob(entry, plans));
    if (r.error || !r.results || r.results.length !== plans.length || !r.results.every(bytesOk)) return warn('Could not split the PDF: ' + (r.error || 'pdf.js returned no file.'));
    for (let i = 0; i < targets.length; i++) await vscode.workspace.fs.writeFile(targets[i], r.results[i]);
    await pro.commit('pages');
    const pick = await say('Split into ' + targets.length + ' files: ' + names[0] + (targets.length > 1 ? ' to ' + names[names.length - 1] : '') + '.', 'Reveal in Explorer');
    if (pick === 'Reveal in Explorer') await vscode.commands.executeCommand('revealInExplorer', targets[0]);
    return targets;
  }

  async function merge() {
    const entry = activeEntry();
    if (!entry || !(await pro.check('merge'))) return;
    const src = plain(entry.uri);
    const picked = await vscode.window.showOpenDialog({ title: 'PDFs to merge with ' + nameOf(src), canSelectMany: true, filters: { PDF: ['pdf'] }, defaultUri: dirOf(src), openLabel: 'Merge' });
    if (!picked || !picked.length) return;
    const others = picked.filter((u) => u.toString() !== src.toString()).sort((a, b) => nameOf(a).localeCompare(nameOf(b), undefined, { numeric: true }));
    if (!others.length) return say('Pick at least one other PDF.');
    const where = await vscode.window.showQuickPick([
      { label: nameOf(src) + ' first', description: 'then ' + others.map(nameOf).join(', '), id: 'first' },
      { label: nameOf(src) + ' last', description: others.map(nameOf).join(', ') + ', then this one', id: 'last' },
    ], { title: 'Merge order' });
    if (!where) return;
    let total = 0;
    const extras = [];
    for (const u of others) {
      const st = await vscode.workspace.fs.stat(u);
      total += st.size;
      if (total > MAX_MERGE_BYTES) return warn('The PDFs are larger than 1 GB together. Merge them in smaller groups.');
      const b = await vscode.workspace.fs.readFile(u);
      const c = new Uint8Array(b.byteLength); c.set(b); extras.push(c);
    }
    const idx = others.map((_, i) => i);
    const order = where.id === 'first' ? [-1, ...idx] : [...idx, -1];
    const mp = P.mergePlan(order);
    const target = await vscode.window.showSaveDialog({
      title: 'Save the merged PDF as',
      defaultUri: vscode.Uri.joinPath(dirOf(src), P.baseName(nameOf(src)) + '-merged.pdf'),
      filters: { PDF: ['pdf'] },
    });
    if (!target) return;
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Merging ' + (others.length + 1) + ' PDFs' }, () => runJob(entry, [mp.plan], extras));
    if (r.error || !r.results || !bytesOk(r.results[0])) return warn('Could not merge: ' + (r.error || 'pdf.js returned no file.'));
    const pages = entry.pages + (r.extraPages || []).reduce((a, b) => a + b, 0);
    await writeAndReport(target, r.results[0], (others.length + 1) + ' PDFs merged, ' + pages + ' pages.');
    await pro.commit('merge');
    return target;
  }

  async function exportAllHighlights() {
    if (!(await pro.check('highlightsAll'))) return;
    const entries = provider.highlights.entries();
    if (!entries.length) return say('No PDF has highlights yet. Select text in a PDF and press H, or click a color.');
    const folders = vscode.workspace.workspaceFolders || [];
    const info = (key) => {
      let uri;
      try { uri = vscode.Uri.parse(key, true); } catch { return null; }
      const folder = vscode.workspace.getWorkspaceFolder ? vscode.workspace.getWorkspaceFolder(uri) : undefined;
      return { uri, fileName: nameOf(uri), relPath: folder ? path.posix.relative(folder.uri.path, uri.path) : null, fileUri: uri.toString(), inWs: !!folder };
    };
    const files = entries.map((e) => Object.assign(info(e.key) || {}, { items: e.items })).filter((f) => f.uri);
    const inWs = files.filter((f) => f.inWs);
    let scope = files;
    if (folders.length && inWs.length && inWs.length < files.length) {
      const c = (l) => l.reduce((n, f) => n + f.items.length, 0);
      const pick = await vscode.window.showQuickPick([
        { label: 'PDFs in this workspace', description: inWs.length + ' files, ' + c(inWs) + ' highlights', id: 'ws' },
        { label: 'Every PDF I highlighted', description: files.length + ' files, ' + c(files) + ' highlights', id: 'all' },
      ], { title: 'Export highlights of all PDFs (Zovo Pro)' });
      if (!pick) return;
      scope = pick.id === 'ws' ? inWs : files;
    }
    const md = allHighlightsToMarkdown(scope, { date: new Date().toISOString().slice(0, 10) });
    const base = folders.length ? folders[0].uri : (provider.active ? dirOf(provider.active.uri) : undefined);
    const target = await vscode.window.showSaveDialog({
      title: 'Save the highlights as',
      defaultUri: base ? vscode.Uri.joinPath(base, 'pdf-highlights.md') : undefined,
      filters: { Markdown: ['md'] },
    });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, Buffer.from(md, 'utf8'));
    await pro.commit('highlightsAll');
    const doc = await vscode.workspace.openTextDocument(target);
    await vscode.window.showTextDocument(doc);
    return target;
  }

  // The toolbar button and the "PDF: Page Tools" command: one quick pick with every Pro tool.
  async function menu() {
    const tag = (f) => { const l = pro.label(f); return l ? ' (' + l + ')' : ''; };
    const pick = await vscode.window.showQuickPick([
      { label: 'Extract pages to a new PDF', description: 'also puts pages in a new order' + tag('pages'), id: 'extract' },
      { label: 'Delete pages', description: tag('pages').trim(), id: 'remove' },
      { label: 'Split into several PDFs', description: tag('pages').trim(), id: 'split' },
      { label: 'Merge with other PDFs', description: tag('merge').trim(), id: 'merge' },
      { label: 'Export highlights of all PDFs to Markdown', description: tag('highlightsAll').trim(), id: 'hl' },
    ], { title: 'PDF page tools (Zovo Pro)', placeHolder: pro.isPro() ? 'Pick a tool' : 'Each tool has 3 free tries on this computer. Zovo Pro is USD 19 once, for every Zovo viewer.' });
    if (!pick) return;
    return { extract, remove, split, merge, hl: exportAllHighlights }[pick.id]();
  }

  return { extract, remove, split, merge, exportAllHighlights, menu, onResult, onPanelClosed, runJob, _pending: pending };
}

module.exports = { createPageTools, JOB_TIMEOUT_MS };
