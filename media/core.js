/*
 * Pure helpers for the PDF webview. No DOM access, so they run in Node tests too.
 * Loaded in the webview as a classic script (sets globalThis.PdfCore) and in Node with require().
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PdfCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---------- matrices ----------
  function multiply(m1, m2) {
    // m = m1 x m2, both [a, b, c, d, e, f] (PDF / canvas convention)
    return [
      m1[0] * m2[0] + m1[2] * m2[1],
      m1[1] * m2[0] + m1[3] * m2[1],
      m1[0] * m2[2] + m1[2] * m2[3],
      m1[1] * m2[2] + m1[3] * m2[3],
      m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
      m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
    ];
  }
  function applyPoint(m, x, y) {
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  }
  function bboxOf(m, x0, y0, x1, y1) {
    const pts = [applyPoint(m, x0, y0), applyPoint(m, x1, y0), applyPoint(m, x0, y1), applyPoint(m, x1, y1)];
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }
  const IDENTITY = [1, 0, 0, 1, 0, 0];

  /**
   * Finds where raster images are painted on a page.
   * fnArray/argsArray come from pdf.js page.getOperatorList(); ops is pdfjs OPS.
   * Returns rectangles in PDF user space (same space as page.view), so the caller can map them with
   * viewport.transform. Image masks (stencils) are left out on purpose: they are drawn in the fill color
   * and should follow the text when the page is inverted.
   */
  function imageRects(fnArray, argsArray, ops, maxRects) {
    const limit = maxRects || 500;
    const rects = [];
    const stack = [];
    let ctm = IDENTITY.slice();
    const isTransform = (a) => Array.isArray(a) && a.length === 6 && a.every((n) => typeof n === 'number' && isFinite(n));
    for (let i = 0; i < fnArray.length && rects.length < limit; i++) {
      const fn = fnArray[i];
      const args = argsArray[i];
      if (fn === ops.save) stack.push(ctm);
      else if (fn === ops.restore) ctm = stack.length ? stack.pop() : IDENTITY.slice();
      else if (fn === ops.transform) {
        const m = args && (isTransform(args) ? args : isTransform(args[0]) ? args[0] : null);
        if (m) ctm = multiply(ctm, m);
      } else if (fn === ops.paintFormXObjectBegin) {
        stack.push(ctm);
        const m = args && args[0];
        if (m && m.length === 6) ctm = multiply(ctm, Array.from(m));
      } else if (fn === ops.paintFormXObjectEnd) {
        ctm = stack.length ? stack.pop() : IDENTITY.slice();
      } else if (fn === ops.paintImageXObject || fn === ops.paintInlineImageXObject) {
        const r = bboxOf(ctm, 0, 0, 1, 1);
        if (r.w > 0.5 && r.h > 0.5) rects.push(r);
      } else if (fn === ops.paintImageXObjectRepeat) {
        // args: [objId, scaleX, scaleY, positions]
        const sx = args[1];
        const sy = args[2];
        const pos = args[3] || [];
        for (let k = 0; k + 1 < pos.length && rects.length < limit; k += 2) {
          const m = multiply(ctm, [sx, 0, 0, sy, pos[k], pos[k + 1]]);
          const r = bboxOf(m, 0, 0, 1, 1);
          if (r.w > 0.5 && r.h > 0.5) rects.push(r);
        }
      }
    }
    return rects;
  }

  /** Maps PDF-space rects to integer canvas pixels with a viewport transform, clipped to the canvas. */
  function toCanvasRects(rects, transform, width, height) {
    const out = [];
    for (const r of rects) {
      const b = bboxOf(transform, r.x, r.y, r.x + r.w, r.y + r.h);
      // Round to the nearest pixel: rounding outward would keep a 1 px line of un-inverted page around photos.
      const x0 = Math.max(0, Math.round(b.x));
      const y0 = Math.max(0, Math.round(b.y));
      const x1 = Math.min(width, Math.round(b.x + b.w));
      const y1 = Math.min(height, Math.round(b.y + b.h));
      if (x1 - x0 >= 1 && y1 - y0 >= 1) out.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    }
    return out;
  }

  // ---------- zoom ----------
  const MIN_SCALE = 0.1;
  const MAX_SCALE = 8;
  const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

  /**
   * zoom: 'page-width' | 'page-fit' | number (1 = 100%).
   * page: {width, height} in CSS px at scale 1. container: {width, height} of the visible area.
   */
  function computeScale(zoom, page, container, gap) {
    const pad = gap == null ? 24 : gap;
    if (typeof zoom === 'number' && isFinite(zoom)) return clampScale(zoom);
    if (!page || !page.width || !page.height || !container) return 1;
    const w = Math.max(50, container.width - pad);
    const h = Math.max(50, container.height - pad);
    if (zoom === 'page-fit') return clampScale(Math.min(w / page.width, h / page.height));
    return clampScale(w / page.width); // page-width and unknown values
  }
  function clampScale(s) {
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(s * 1000) / 1000));
  }
  function nextZoom(current, dir) {
    if (dir > 0) {
      for (const s of ZOOM_STEPS) if (s > current + 0.001) return s;
      return clampScale(Math.min(MAX_SCALE, current * 1.25));
    }
    for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) if (ZOOM_STEPS[i] < current - 0.001) return ZOOM_STEPS[i];
    return clampScale(Math.max(MIN_SCALE, current / 1.25));
  }
  /** Parses user zoom input: "125", "125%", "1.25x", "fit width", "page-fit". Returns null when invalid. */
  function parseZoom(input) {
    const s = String(input == null ? '' : input).trim().toLowerCase();
    if (s === 'page-width' || s === 'fit width' || s === 'width') return 'page-width';
    if (s === 'page-fit' || s === 'fit page' || s === 'page' || s === 'fit') return 'page-fit';
    let m = /^(\d+(?:\.\d+)?)\s*%?$/.exec(s);
    if (m) return clampScale(parseFloat(m[1]) / 100);
    m = /^(\d+(?:\.\d+)?)\s*x$/.exec(s);
    if (m) return clampScale(parseFloat(m[1]));
    return null;
  }

  // ---------- search ----------
  function foldChar(ch) {
    const l = ch.toLowerCase();
    return l.length === ch.length ? l : ch;
  }
  function fold(str) {
    let out = '';
    for (const ch of str) out += foldChar(ch);
    return out;
  }
  /**
   * Builds the searchable text of one page from pdf.js text items.
   * items: [{str, hasEOL}]. Returns {text, starts}: starts[i] is the offset of item i in text.
   * A space is inserted at line ends (hasEOL) so words on two lines do not merge.
   */
  function buildPageText(items) {
    let text = '';
    const starts = new Array(items.length);
    for (let i = 0; i < items.length; i++) {
      const it = items[i] || {};
      starts[i] = text.length;
      text += typeof it.str === 'string' ? it.str : '';
      if (it.hasEOL && !/\s$/.test(text)) text += ' ';
    }
    return { text, starts };
  }
  /** Splits a [start,end) range of page text into per-item pieces: [{item, from, to}]. */
  function rangeToItems(starts, items, start, end) {
    const parts = [];
    for (let i = 0; i < items.length; i++) {
      const len = typeof items[i].str === 'string' ? items[i].str.length : 0;
      const a = starts[i];
      const b = a + len;
      if (b <= start) continue;
      if (a >= end) break;
      const from = Math.max(start, a) - a;
      const to = Math.min(end, b) - a;
      if (to > from) parts.push({ item: i, from, to });
    }
    return parts;
  }
  /**
   * Finds query in one page. Case-insensitive unless opts.caseSensitive. Whitespace in the query
   * matches any run of whitespace on the page. Returns [{start, end, parts}].
   */
  function findInPage(items, query, opts) {
    const o = opts || {};
    const q = String(query || '').trim();
    if (!q) return [];
    const { text, starts } = buildPageText(items);
    const hay = (o.caseSensitive ? text : fold(text)).replace(/\s/g, ' ');
    const needle = (o.caseSensitive ? q : fold(q)).replace(/\s+/g, ' ');
    const res = [];
    const max = o.maxMatches || 10000;
    let from = 0;
    while (res.length < max) {
      const idx = hay.indexOf(needle, from);
      if (idx < 0) break;
      const end = idx + needle.length;
      if (!o.wholeWord || (isBoundary(hay, idx - 1) && isBoundary(hay, end))) {
        res.push({ start: idx, end, parts: rangeToItems(starts, items, idx, end) });
      }
      from = idx + Math.max(1, needle.length);
    }
    return res;
  }
  function isBoundary(s, i) {
    if (i < 0 || i >= s.length) return true;
    return !/[\p{L}\p{N}_]/u.test(s[i]);
  }
  /** Splits a string into plain and highlighted segments for the given [{from,to,cls}] ranges. */
  function segments(str, ranges) {
    const sorted = ranges.filter((r) => r.to > r.from).sort((a, b) => a.from - b.from);
    const out = [];
    let pos = 0;
    for (const r of sorted) {
      const from = Math.max(r.from, pos);
      if (from >= r.to) continue;
      if (from > pos) out.push({ text: str.slice(pos, from), cls: null });
      out.push({ text: str.slice(from, r.to), cls: r.cls || 'hl' });
      pos = r.to;
    }
    if (pos < str.length) out.push({ text: str.slice(pos), cls: null });
    return out;
  }

  // ---------- outline ----------
  /**
   * Turns a pdf.js outline (from doc.getOutline()) into a plain tree with stable ids.
   * Titles are kept as text; the webview renders them with textContent, never innerHTML.
   */
  function flattenOutline(outline, maxItems) {
    const limit = maxItems || 5000;
    let count = 0;
    function walk(nodes, depth, prefix) {
      const out = [];
      for (let i = 0; i < (nodes || []).length && count < limit; i++) {
        const n = nodes[i] || {};
        count++;
        const id = prefix ? prefix + '.' + i : String(i);
        const title = typeof n.title === 'string' && n.title.trim() ? n.title.replace(/\s+/g, ' ').trim() : '(untitled)';
        out.push({
          id,
          title: title.length > 300 ? title.slice(0, 300) + '…' : title,
          depth,
          dest: n.dest == null ? null : n.dest,
          url: typeof n.url === 'string' ? n.url : null,
          children: depth < 32 ? walk(n.items, depth + 1, id) : [],
        });
      }
      return out;
    }
    return walk(outline, 0, '');
  }
  /**
   * Resolves an outline or link destination to {pageIndex, top}. top is in PDF units or null.
   * getDestination(name) and getPageIndex(ref) are the pdf.js document methods (async).
   */
  async function resolveDest(dest, getDestination, getPageIndex) {
    let explicit = dest;
    if (typeof dest === 'string') explicit = await getDestination(dest);
    if (!Array.isArray(explicit) || explicit.length === 0) return null;
    const ref = explicit[0];
    let pageIndex;
    if (Number.isInteger(ref)) pageIndex = ref;
    else if (ref && typeof ref === 'object') pageIndex = await getPageIndex(ref);
    else return null;
    const kind = explicit[1] && explicit[1].name;
    let top = null;
    if (kind === 'XYZ' && typeof explicit[3] === 'number') top = explicit[3];
    else if ((kind === 'FitH' || kind === 'FitBH') && typeof explicit[2] === 'number') top = explicit[2];
    else if (kind === 'FitR' && typeof explicit[5] === 'number') top = explicit[5];
    return { pageIndex, top };
  }

  // ---------- links ----------
  const SAFE_SCHEMES = /^(https?:|mailto:)/i;
  function isSafeExternalUrl(url) {
    if (typeof url !== 'string' || url.length > 2048) return false;
    try {
      const u = new URL(url);
      return SAFE_SCHEMES.test(u.protocol);
    } catch {
      return false;
    }
  }

  // ---------- data ----------
  /**
   * Normalises the PDF bytes posted by the extension host. VS Code transfers a plain Uint8Array as bytes,
   * but a Node Buffer arrives JSON-serialised as {type: 'Buffer', data: [...]}. Accept every shape.
   */
  function toBytes(d) {
    if (d instanceof Uint8Array) return d;
    if (d instanceof ArrayBuffer) return new Uint8Array(d);
    if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
    if (d && d.type === 'Buffer' && Array.isArray(d.data)) return Uint8Array.from(d.data);
    if (Array.isArray(d)) return Uint8Array.from(d);
    if (d && typeof d === 'object' && typeof d.length !== 'number') {
      // {0: 37, 1: 80, ...} from structured clones of exotic views
      const keys = Object.keys(d);
      if (keys.length && keys.every((k, i) => k === String(i))) return Uint8Array.from(keys.map((k) => d[k]));
    }
    return new Uint8Array(0);
  }

  // ---------- dark mode ----------
  /** mode: 'auto' | 'on' | 'off'. themeKind: body class from VS Code (vscode-dark, vscode-light, ...). */
  function isDark(mode, themeKind) {
    if (mode === 'on') return true;
    if (mode === 'off') return false;
    return themeKind === 'vscode-dark' || themeKind === 'vscode-high-contrast';
  }

  /** Which pages to render: visible ones plus a margin, given page tops/heights and the scroll window. */
  function visiblePages(tops, heights, scrollTop, viewHeight, margin) {
    const m = margin == null ? viewHeight : margin;
    const lo = scrollTop - m;
    const hi = scrollTop + viewHeight + m;
    const out = [];
    // binary search for the first page whose bottom is below lo
    let a = 0;
    let b = tops.length;
    while (a < b) {
      const mid = (a + b) >> 1;
      if (tops[mid] + heights[mid] < lo) a = mid + 1;
      else b = mid;
    }
    for (let i = a; i < tops.length && tops[i] <= hi; i++) out.push(i);
    return out;
  }
  /** Page number (1-based) that holds the middle third of the view, or the most visible one. */
  function currentPage(tops, heights, scrollTop, viewHeight) {
    if (!tops.length) return 1;
    const probe = scrollTop + Math.min(viewHeight / 3, 200);
    let a = 0;
    let b = tops.length - 1;
    while (a < b) {
      const mid = (a + b + 1) >> 1;
      if (tops[mid] <= probe) a = mid;
      else b = mid - 1;
    }
    return a + 1;
  }

  /**
   * What the viewer does when VS Code hides or shows its tab. A hidden tab keeps its webview, so it
   * frees its page canvases ('free') and draws the visible pages again when shown ('render').
   */
  function visibilityAction(wasVisible, visible) {
    if (wasVisible && !visible) return 'free';
    if (!wasVisible && visible) return 'render';
    return null;
  }

  // ---------- highlights and page colors ----------
  /**
   * Turns the client rectangles of a text selection into rectangles on one page, as fractions of the
   * page box (0..1), so a highlight stays in place at every zoom. Rectangles outside the page, empty ones
   * and very tall ones (the text layer's end-of-content filler) are left out. Rectangles on the same
   * line that touch or overlap are merged. Returns [[x, y, w, h], ...] rounded to 5 decimals.
   */
  function selectionRects(clientRects, pageBox, maxRects) {
    const limit = maxRects || 200;
    const W = pageBox.width;
    const H = pageBox.height;
    if (!(W > 0) || !(H > 0)) return [];
    const rs = [];
    for (const r of clientRects || []) {
      if (!r || !(r.width > 1) || !(r.height > 1)) continue;
      if (r.height > H * 0.2) continue;
      const x0 = Math.max(r.left, pageBox.left);
      const y0 = Math.max(r.top, pageBox.top);
      const x1 = Math.min(r.left + r.width, pageBox.left + W);
      const y1 = Math.min(r.top + r.height, pageBox.top + H);
      if (x1 - x0 < 1 || y1 - y0 < 1) continue;
      rs.push({ x0, y0, x1, y1 });
    }
    rs.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
    const merged = [];
    for (const r of rs) {
      const m = merged.find((q) => {
        const h = Math.min(q.y1 - q.y0, r.y1 - r.y0);
        const overlapY = Math.min(q.y1, r.y1) - Math.max(q.y0, r.y0);
        return overlapY > h * 0.6 && r.x0 <= q.x1 + h * 0.6 && r.x1 >= q.x0 - h * 0.6;
      });
      if (m) { m.x0 = Math.min(m.x0, r.x0); m.y0 = Math.min(m.y0, r.y0); m.x1 = Math.max(m.x1, r.x1); m.y1 = Math.max(m.y1, r.y1); }
      else merged.push(Object.assign({}, r));
      if (merged.length >= limit) break;
    }
    const f = (n) => Math.round(n * 1e5) / 1e5;
    return merged.map((r) => [f((r.x0 - pageBox.left) / W), f((r.y0 - pageBox.top) / H), f((r.x1 - r.x0) / W), f((r.y1 - r.y0) / H)]);
  }

  /** Collapses white space and cuts the selected text to at most max characters. */
  function cleanSelectionText(s, max) {
    const t = String(s == null ? '' : s).replace(/­/g, '').replace(/-\s*\n\s*/g, '').replace(/\s+/g, ' ').trim();
    const n = max || 2000;
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  }

  /** Page look: 'dark' wins over 'sepia'; anything else is the page as printed. */
  function pageMode(dark, sepia) {
    return dark ? 'dark' : sepia ? 'sepia' : 'light';
  }

  /** Warm paper color. Sepia pages multiply the rendered page by it: white becomes this, black stays black. */
  const SEPIA_PAPER = '#f4ecd8';

  /**
   * How a page mode changes the rendered canvas: { filter } (a canvas filter, for dark) or
   * { multiply } (a color to multiply with, for sepia), or null when the canvas stays as rendered.
   */
  function pageTint(mode) {
    if (mode === 'dark') return { filter: 'invert(0.88) hue-rotate(180deg)' };
    if (mode === 'sepia') return { multiply: SEPIA_PAPER };
    return null;
  }

  return {
    multiply, applyPoint, bboxOf, imageRects, toCanvasRects,
    computeScale, clampScale, nextZoom, parseZoom, ZOOM_STEPS, MIN_SCALE, MAX_SCALE,
    fold, buildPageText, rangeToItems, findInPage, segments,
    flattenOutline, resolveDest, isSafeExternalUrl, isDark, visiblePages, currentPage, toBytes, visibilityAction,
    selectionRects, cleanSelectionText, pageMode, pageTint, SEPIA_PAPER,
  };
});
