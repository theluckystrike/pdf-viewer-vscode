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
    default:
      return null;
  }
}

/** Settings sent to the webview, normalised from the workspace configuration getter. */
function readConfig(get) {
  const mode = get('darkMode', 'auto');
  const zoom = get('defaultZoom', 'page-width');
  const max = Number(get('maxFileSizeMB', 200));
  return {
    darkMode: mode === 'on' || mode === 'off' ? mode : 'auto',
    keepImagesInDarkMode: get('keepImagesInDarkMode', true) !== false,
    defaultZoom: zoom === 'page-fit' || zoom === 'auto' ? (zoom === 'auto' ? 'page-width' : zoom) : 'page-width',
    rememberPage: get('rememberLastPage', true) !== false,
    maxFileSizeBytes: Math.round((isFinite(max) && max > 0 ? max : 200) * 1024 * 1024),
  };
}

module.exports = { parseWebviewMessage, readConfig, isZoom };
