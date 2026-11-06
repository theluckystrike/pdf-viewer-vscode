'use strict';
// Validates messages that come from the webview before the extension acts on them.
// The webview renders untrusted PDF content, so the host treats every message as untrusted input.

const SAFE_URL = /^(https?:|mailto:)/i;

function isZoom(z) {
  if (z === 'page-width' || z === 'page-fit') return true;
  return typeof z === 'number' && isFinite(z) && z >= 0.1 && z <= 8;
}

/** Returns a clean message object, or null when the message is unknown or malformed. */
function parseWebviewMessage(m) {
  if (!m || typeof m !== 'object' || typeof m.type !== 'string') return null;
  switch (m.type) {
    case 'ready':
    case 'loadAnyway':
      return { type: m.type };
    case 'state': {
      if (!Number.isInteger(m.page) || m.page < 1 || m.page > 1e6) return null;
      return { type: 'state', page: m.page, zoom: isZoom(m.zoom) ? m.zoom : undefined };
    }
    case 'rendered':
      return Number.isInteger(m.page) && m.page >= 1 ? { type: 'rendered', page: m.page, dark: m.dark === true } : null;
    case 'info':
      return Number.isInteger(m.pages) && m.pages >= 0 ? { type: 'info', pages: m.pages } : null;
    case 'openExternal': {
      if (typeof m.url !== 'string' || m.url.length > 2048) return null;
      let u;
      try { u = new URL(m.url); } catch { return null; }
      if (!SAFE_URL.test(u.protocol)) return null;
      return { type: 'openExternal', url: u.toString() };
    }
    case 'error':
      return { type: 'error', message: String(m.message == null ? '' : m.message).slice(0, 500) };
    case 'sidebar':
      return typeof m.open === 'boolean' ? { type: 'sidebar', open: m.open } : null;
    default:
      return null;
  }
}

/** Settings sent to the webview, normalised from the workspace configuration getter. */
function readConfig(get) {
  const mode = get('darkMode', 'auto');
  const zoom = get('defaultZoom', 'page-width');
  const max = Number(get('maxFileSizeMB', 200));
  const sidebar = get('sidebar', 'closed');
  return {
    darkMode: mode === 'on' || mode === 'off' ? mode : 'auto',
    keepImagesInDarkMode: get('keepImagesInDarkMode', true) !== false,
    defaultZoom: zoom === 'page-fit' || zoom === 'auto' ? (zoom === 'auto' ? 'page-width' : zoom) : 'page-width',
    rememberPage: get('rememberLastPage', true) !== false,
    maxFileSizeBytes: Math.round((isFinite(max) && max > 0 ? max : 200) * 1024 * 1024),
    sidebar: sidebar === 'open' || sidebar === 'remember' ? sidebar : 'closed',
  };
}

/**
 * Reads the PDF open parameters from a link fragment, as in `report.pdf#page=4` or `report.pdf#nameddest=results`
 * (the same form browsers and Acrobat understand). A bare fragment without `=` is a named destination.
 * Returns { page?, dest?, zoom? } or null. zoom is a scale (150 -> 1.5). Unknown keys are ignored.
 */
function parsePdfFragment(fragment) {
  if (typeof fragment !== 'string') return null;
  let f = fragment.replace(/^#/, '').trim();
  if (!f || f.length > 1000) return null;
  const dec = (s) => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; } };
  const out = {};
  if (!f.includes('=')) {
    const name = dec(f);
    if (name.length <= 200) out.dest = name;
  } else {
    for (const part of f.split('&')) {
      const eq = part.indexOf('=');
      if (eq < 1) continue;
      const k = part.slice(0, eq).trim().toLowerCase();
      const v = dec(part.slice(eq + 1)).trim();
      if (k === 'page' && /^\d{1,7}$/.test(v) && +v >= 1) out.page = +v;
      else if (k === 'nameddest' && v && v.length <= 200) out.dest = v;
      else if (k === 'zoom') {
        const z = parseFloat(v.split(',')[0]);
        if (isFinite(z) && z >= 10 && z <= 800) out.zoom = Math.round(z) / 100;
      }
    }
  }
  return Object.keys(out).length ? out : null;
}

/** Escapes text for a Markdown link label. */
function mdLabel(s) { return String(s).replace(/[\\\[\]*_`<>]/g, (c) => '\\' + c); }

/** Percent-encodes a path for a Markdown link target, keeping the slashes. */
function encodeLinkPath(p) {
  return String(p).split('/').map((seg) => encodeURIComponent(seg).replace(/[()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())).join('/');
}

/**
 * A Markdown link that opens the PDF at a page. relPath is the path inside the workspace folder
 * (VS Code resolves a leading / from the workspace root), or null for a file outside the workspace,
 * in which case fileUri (a file: URI string) is used.
 */
function markdownPageLink({ fileName, relPath, fileUri, page }) {
  const n = Number.isInteger(page) && page >= 1 ? page : 1;
  const target = relPath != null ? '/' + encodeLinkPath(String(relPath).replace(/^\/+/, '')) : String(fileUri).split('#')[0];
  return `[${mdLabel(fileName)}, page ${n}](${target}#page=${n})`;
}

module.exports = { parseWebviewMessage, readConfig, isZoom, parsePdfFragment, markdownPageLink, encodeLinkPath };
