'use strict';
// Builds the webview HTML. Pure function so tests can check the Content-Security-Policy.

const crypto = require('crypto');
const { footerHtml, FOOTER_CSS } = require('./support');

function nonce() {
  return crypto.randomBytes(18).toString('base64').replace(/[^A-Za-z0-9]/g, '');
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * uris: { core, viewer, css, pdfjs, worker, cmaps, fonts, wasm } as webview URIs (strings).
 * cspSource: webview.cspSource.
 * opts.showSupportLinks: false hides the small Sponsor and More free viewers footer (setting pdfViewer.showSupportLinks).
 */
function buildHtml(uris, cspSource, n, opts) {
  const footer = footerHtml('pdfViewer', !(opts && opts.showSupportLinks === false), 'zovo-support-fixed');
  const N = n || nonce();
  const src = escapeAttr(cspSource);
  const csp = [
    "default-src 'none'",
    `img-src ${src} blob: data:`,
    `style-src ${src} 'nonce-${N}'`,
    `font-src ${src} data: blob:`,
    // pdf.js is loaded as an ES module from the extension folder; wasm decoders need wasm-unsafe-eval (not unsafe-eval).
    `script-src 'nonce-${N}' ${src} 'wasm-unsafe-eval'`,
    'worker-src blob:',
    `connect-src ${src}`,
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
  const a = (k) => escapeAttr(uris[k]);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${a('css')}" nonce="${N}">
${footer ? `<style nonce="${N}">${FOOTER_CSS}</style>` : ''}
<title>PDF</title>
</head>
<body data-pdfjs="${a('pdfjs')}" data-worker="${a('worker')}" data-cmaps="${a('cmaps')}" data-fonts="${a('fonts')}" data-wasm="${a('wasm')}">
<div id="toolbar" role="toolbar" aria-label="PDF toolbar">
  <button class="tb" id="sidebarBtn" title="Outline and pages (sidebar)" aria-pressed="false" aria-label="Toggle sidebar"><svg viewBox="0 0 16 16"><path d="M2 2h12v12H2V2zm1 1v10h3V3H3zm4 0v10h6V3H7z"/></svg></button>
  <span class="sep"></span>
  <button class="tb" id="prevBtn" title="Previous page" aria-label="Previous page"><svg viewBox="0 0 16 16"><path d="M8 4l5 6H3z"/></svg></button>
  <button class="tb" id="nextBtn" title="Next page" aria-label="Next page"><svg viewBox="0 0 16 16"><path d="M8 12L3 6h10z"/></svg></button>
  <input id="pageInput" type="number" min="1" value="1" aria-label="Page number"><span>&nbsp;/&nbsp;<span id="pageCount">0</span></span>
  <span class="sep"></span>
  <button class="tb" id="zoomOutBtn" title="Zoom out (Ctrl -)" aria-label="Zoom out"><svg viewBox="0 0 16 16"><path d="M3 7h10v2H3z"/></svg></button>
  <select id="zoomSelect" aria-label="Zoom">
    <option value="page-width">Fit width</option>
    <option value="page-fit">Fit page</option>
    <option value="0.5">50%</option>
    <option value="0.75">75%</option>
    <option value="1">100%</option>
    <option value="1.25">125%</option>
    <option value="1.5">150%</option>
    <option value="2">200%</option>
    <option value="3">300%</option>
    <option value="4">400%</option>
    <option data-custom="1" value="custom" hidden></option>
  </select>
  <button class="tb" id="zoomInBtn" title="Zoom in (Ctrl +)" aria-label="Zoom in"><svg viewBox="0 0 16 16"><path d="M7 3h2v4h4v2H9v4H7V9H3V7h4z"/></svg></button>
  <span class="sep"></span>
  <input id="searchInput" type="search" placeholder="Find in PDF" aria-label="Find in PDF" spellcheck="false">
  <button class="tb" id="caseBtn" title="Match case" aria-pressed="false" aria-label="Match case">Aa</button>
  <button class="tb" id="searchPrev" title="Previous match (Shift+Enter)" aria-label="Previous match"><svg viewBox="0 0 16 16"><path d="M8 4l5 6H3z"/></svg></button>
  <button class="tb" id="searchNext" title="Next match (Enter)" aria-label="Next match"><svg viewBox="0 0 16 16"><path d="M8 12L3 6h10z"/></svg></button>
  <span id="searchCount" aria-live="polite"></span>
  <span class="spacer"></span>
  <span id="status" aria-live="polite"></span>
  <span id="fileName"></span>
  <button class="tb" id="toolsBtn" hidden title="Page tools: extract, delete, split and merge pages, export all highlights (Zovo Pro)" aria-label="Page tools"><svg viewBox="0 0 16 16"><path d="M4 1h6l3 3v8H4V1zm1 1v9h7V5H9V2H5zM2 4h1v10h8v1H2V4z"/></svg><span class="proBadge" id="toolsBadge">PRO</span></button>
  <button class="tb" id="sepiaBtn" title="Sepia pages: off (click for warm paper colors)" aria-pressed="false" aria-label="Sepia pages"><svg viewBox="0 0 16 16"><path d="M3 1.5h7l3 3v10H3v-13zm1 1v11h8V5h-2.5V2.5H4zm1.5 4h5v1h-5v-1zm0 2h5v1h-5v-1zm0 2h3.5v1H5.5v-1z"/></svg></button>
  <button class="tb" id="darkBtn" title="Dark pages" aria-pressed="false" aria-label="Dark pages"><svg viewBox="0 0 16 16"><path d="M6 1.5a6.5 6.5 0 1 0 8.5 8.5A5.5 5.5 0 0 1 6 1.5z"/></svg></button>
</div>
<div id="main">
  <aside id="sidebar" hidden>
    <div class="tabs" role="tablist">
      <button id="tab-outline" role="tab" aria-selected="true">Outline</button>
      <button id="tab-thumbs" role="tab" aria-selected="false">Pages</button>
      <button id="tab-hls" role="tab" aria-selected="false">Highlights</button>
    </div>
    <div id="outline" class="active" role="tree" aria-label="Outline"></div>
    <div id="thumbs" hidden aria-label="Page thumbnails"></div>
    <div id="hls" hidden aria-label="Highlights">
      <div class="hlHead"><span id="hlCount">0 highlights</span><button id="hlCopy" class="linkBtn" title="Copy all highlights as a Markdown list with a link to each page">Copy as Markdown</button><button id="hlAll" class="linkBtn" hidden title="Save the highlights of every PDF in one Markdown file (Zovo Pro)">All PDFs</button></div>
      <ul id="hlList"></ul>
    </div>
  </aside>
  <div id="viewer" tabindex="0"><div id="pages"></div></div>
</div>
<div id="hlPop" hidden role="toolbar" aria-label="Highlight">
  <button class="hlSwatch" data-color="yellow" title="Highlight yellow (H)" aria-label="Highlight yellow"></button>
  <button class="hlSwatch" data-color="green" title="Highlight green" aria-label="Highlight green"></button>
  <button class="hlSwatch" data-color="blue" title="Highlight blue" aria-label="Highlight blue"></button>
  <button class="hlSwatch" data-color="pink" title="Highlight pink" aria-label="Highlight pink"></button>
</div>
<div id="message" hidden role="alert"></div>
${footer}
<script nonce="${N}" src="${a('core')}"></script>
<script nonce="${N}" type="module" src="${a('viewer')}"></script>
</body>
</html>`;
}

module.exports = { buildHtml, nonce, escapeAttr };
