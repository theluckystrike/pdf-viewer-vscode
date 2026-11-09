'use strict';
// Pure helpers for the Pro page tools: page lists typed by the user, the pdf.js extractPages() plans built from
// them, split plans and output file names. No VS Code and no pdf.js here, so every rule is unit tested.
//
// pdf.js 5.7 (bundled) writes the new PDF in its worker: PDFDocumentProxy.extractPages(pageInfos), where each
// pageInfo is { document, includePages?, excludePages? }, document null = the open PDF, page numbers 0-based,
// [a, b] = an inclusive range. Pages come out in the order of the pageInfos. The webview turns the
// plans below into that call ({ src: -1 } = the open PDF, { src: k } = the k-th extra file sent with the job).

const MAX_PARTS = 500; // a typed list longer than this is almost surely a mistake
const MAX_FILES_OUT = 1000; // a split never writes more files than this

/**
 * Parses "1-3, 7, 10-" into ordered segments [{ from, to }] (1-based, inclusive). Accepted: N, N-M, N- (to the
 * end), -M (from page 1), "last" for the last page, and commas, semicolons or spaces between parts. Returns
 * { segments } or { error } with a sentence for the input box.
 */
function parsePageList(text, numPages) {
  if (!Number.isInteger(numPages) || numPages < 1) return { error: 'The PDF has no pages.' };
  const s = String(text == null ? '' : text).trim().toLowerCase().replace(/\s*[-–—]\s*/g, '-');
  if (!s) return { error: 'Type page numbers, for example 1-3, 7, 10-' };
  const parts = s.split(/[\s,;]+/).filter(Boolean);
  if (parts.length > MAX_PARTS) return { error: 'Too many parts. Use ranges such as 1-50.' };
  const num = (t, dflt) => {
    if (t === '') return dflt;
    if (t === 'last' || t === 'end') return numPages;
    return /^\d{1,7}$/.test(t) ? Number(t) : NaN;
  };
  const segments = [];
  for (const p of parts) {
    const m = /^([a-z0-9]*)-([a-z0-9]*)$/.exec(p);
    let from;
    let to;
    if (m) {
      if (!m[1] && !m[2]) return { error: '"-" needs a page number on at least one side.' };
      from = num(m[1], 1);
      to = num(m[2], numPages);
    } else {
      from = to = num(p, NaN);
    }
    if (!Number.isInteger(from) || !Number.isInteger(to)) return { error: '"' + p + '" is not a page or a range. Example: 1-3, 7, 10-' };
    if (from < 1 || to < 1) return { error: 'Pages start at 1.' };
    if (from > numPages || to > numPages) return { error: 'This PDF has ' + numPages + ' page' + (numPages === 1 ? '' : 's') + ' ("' + p + '").' };
    if (from > to) return { error: '"' + p + '" goes backwards. Write ' + to + '-' + from + ', or list the pages one by one for a reverse order.' };
    segments.push({ from, to });
  }
  return { segments };
}

/** Number of pages the segments name, counting repeats. */
function countPages(segments) {
  return segments.reduce((n, s) => n + (s.to - s.from + 1), 0);
}

/** The set of 1-based pages named by the segments. */
function pageSet(segments) {
  const set = new Set();
  for (const s of segments) for (let p = s.from; p <= s.to; p++) set.add(p);
  return set;
}

/** True when the segments go up and do not overlap, so one pageInfo keeps them in order. */
function isAscending(segments) {
  for (let i = 1; i < segments.length; i++) if (segments[i].from <= segments[i - 1].to) return false;
  return true;
}

const toRange = (s) => (s.from === s.to ? s.from - 1 : [s.from - 1, s.to - 1]);

/**
 * Plan for "extract" (keep these pages, in the typed order). One pageInfo when the list goes up, otherwise one
 * pageInfo per segment, so "3, 1-2" puts page 3 first. src -1 = the open PDF.
 */
function extractPlan(segments, src = -1) {
  if (!segments.length) return [];
  if (isAscending(segments)) return [{ src, includePages: segments.map(toRange) }];
  return segments.map((s) => ({ src, includePages: [toRange(s)] }));
}

/** Plan for "delete these pages". { error } when nothing would be left. */
function deletePlan(segments, numPages) {
  const gone = pageSet(segments);
  if (gone.size >= numPages) return { error: 'That would delete every page. Leave at least one.' };
  return { plan: [{ src: -1, excludePages: segments.map(toRange) }], left: numPages - gone.size, removed: gone.size };
}

/**
 * Split plans. mode 'every' with n pages per file, 'each' (one file per page) or 'at' with segments (one file per
 * typed range). Returns { parts: [{ from, to }] } or { error }.
 */
function splitParts(mode, numPages, arg) {
  let parts = [];
  if (mode === 'each') arg = 1;
  if (mode === 'every' || mode === 'each') {
    const n = Number(arg);
    if (!Number.isInteger(n) || n < 1) return { error: 'Type a whole number of pages per file, 1 or more.' };
    if (n >= numPages) return { error: 'With ' + n + ' pages per file the PDF (' + numPages + ' pages) would stay in one piece.' };
    for (let p = 1; p <= numPages; p += n) parts.push({ from: p, to: Math.min(numPages, p + n - 1) });
  } else if (mode === 'at') {
    if (!Array.isArray(arg) || !arg.length) return { error: 'Type the ranges, one file per range. Example: 1-4, 5-9, 10-' };
    parts = arg.map((s) => ({ from: s.from, to: s.to }));
  } else {
    return { error: 'Unknown split mode.' };
  }
  if (parts.length > MAX_FILES_OUT) return { error: 'That would write ' + parts.length + ' files. The limit is ' + MAX_FILES_OUT + '.' };
  return { parts };
}

/** "pages-1-3_7" style label for a file name. Long lists are shortened. */
function rangeLabel(segments) {
  const s = segments.map((x) => (x.from === x.to ? String(x.from) : x.from + '-' + x.to)).join('_');
  return s.length > 40 ? s.slice(0, 40).replace(/[_-]+[^_-]*$/, '') + '_etc' : s;
}

/** File name without its .pdf extension. */
function baseName(fileName) {
  return String(fileName || 'document').replace(/\.pdf$/i, '') || 'document';
}

/** Output names for a split: "<base>-part-01-p1-4.pdf", zero-padded so they sort. */
function splitNames(fileName, parts) {
  const b = baseName(fileName);
  const w = String(parts.length).length < 2 ? 2 : String(parts.length).length;
  return parts.map((p, i) => b + '-part-' + String(i + 1).padStart(w, '0') + '-p' + (p.from === p.to ? p.from : p.from + '-' + p.to) + '.pdf');
}

/** Plan for a merge: the open PDF first unless the user moved it, then the extra files in the chosen order. */
function mergePlan(order) {
  // order: array of src numbers, -1 = the open PDF, k = extra file k
  if (!Array.isArray(order) || order.length < 2) return { error: 'Pick at least one more PDF to merge.' };
  return { plan: order.map((src) => ({ src })) };
}

/**
 * Checks a plan that came back from the webview or is about to be sent: only known keys, page indices in range.
 * extraCount = number of extra files. Returns true when it is safe to hand to pdf.js.
 */
function validPlan(plan, numPages, extraCount, extraPages) {
  if (!Array.isArray(plan) || !plan.length || plan.length > MAX_PARTS) return false;
  const okIdx = (i, max) => Number.isInteger(i) && i >= 0 && i < max;
  for (const info of plan) {
    if (!info || typeof info !== 'object') return false;
    for (const k of Object.keys(info)) if (!['src', 'includePages', 'excludePages'].includes(k)) return false;
    if (!(info.src === -1 || (Number.isInteger(info.src) && info.src >= 0 && info.src < (extraCount || 0)))) return false;
    const max = info.src === -1 ? numPages : (extraPages && extraPages[info.src]) || Infinity;
    for (const key of ['includePages', 'excludePages']) {
      if (info[key] === undefined) continue;
      if (!Array.isArray(info[key]) || info[key].length > MAX_PARTS) return false;
      for (const r of info[key]) {
        if (Array.isArray(r)) { if (r.length !== 2 || !okIdx(r[0], max) || !okIdx(r[1], max) || r[0] > r[1]) return false; }
        else if (!okIdx(r, max)) return false;
      }
    }
  }
  return true;
}

module.exports = {
  parsePageList, countPages, pageSet, isAscending, extractPlan, deletePlan, splitParts, rangeLabel, baseName, splitNames,
  mergePlan, validPlan, MAX_PARTS, MAX_FILES_OUT
};
