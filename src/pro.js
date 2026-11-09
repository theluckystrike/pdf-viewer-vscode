'use strict';
// PDF Viewer Pro on top of the shared Zovo license module (src/license, copied unchanged from
// factory/sprint/license). Pro features: page tools that save a new PDF (extract, delete, reorder, split),
// merging PDFs, and exporting the highlights of every PDF to one Markdown file. Everything that was free stays free.
// Rules: nothing about Pro shows on open; each Pro feature works TRIAL_USES times on this computer first (a try is
// used only when a file was really written); after that a click explains it once (a modal the user started) with
// the ways to unlock. No network except what the user starts (the GitHub Sponsors unlock, or a page in the browser).
const { createLicense } = require('./license');

const PRO_ENABLED = true;
const SKU = 'pdf-pro';
const TRIAL_USES = 3;
const TRIAL_KEY = 'pdfViewer.proTrial';

const FEATURES = {
  pages: {
    title: 'Page tools',
    detail: 'Saves the pages you pick as a new PDF: extract pages, delete pages, put pages in a new order, or split one PDF into several files. Links, the outline and form fields come along. Your original file is only replaced if you choose it in the save dialog.'
  },
  merge: {
    title: 'Merge PDFs',
    detail: 'Joins this PDF and the PDFs you pick into one new PDF, in the order you choose. The source files are not changed.'
  },
  highlightsAll: {
    title: 'Highlights of all PDFs',
    detail: 'Writes the highlights of every PDF you have highlighted into one Markdown file, grouped by file, with the color and a link to each page. Good for a literature review or a reading log.'
  }
};

const PRICE_LINE = 'Zovo Pro is USD 19 once and unlocks the Pro features in every Zovo viewer. Already bought the "$19 one time" tier on GitHub Sponsors? Choose Unlock with GitHub Sponsors: it asks GitHub one question and sends nothing else. Paid with PayPal? Choose I have a license key.';
const FREE_LINE = 'Everything else in PDF Viewer stays free: reading, dark and sepia pages, search, outline, thumbnails, highlights, Copy Highlights as Markdown and page links.';

function createPro({ vscode, context, license, enabled }) {
  const on = enabled === undefined ? PRO_ENABLED : enabled;
  const lic = license || createLicense({ vscode, context, sku: SKU, name: 'Zovo', commandPrefix: 'pdfViewer' });
  const used = (f) => Number((context.globalState.get(TRIAL_KEY) || {})[f]) || 0;
  const left = (f) => (FEATURES[f] ? Math.max(0, TRIAL_USES - used(f)) : 0);
  const pro = () => !on || lic.isPro(SKU);

  async function explain(f) {
    const ft = FEATURES[f];
    const tried = used(f) >= TRIAL_USES ? 'You have used the ' + TRIAL_USES + ' free tries of this feature on this computer.\n\n' : '';
    return lic.requirePro(ft.title, tried + ft.detail + '\n\n' + PRICE_LINE + '\n\n' + FREE_LINE);
  }

  // Call when the user has chosen a Pro action, before asking for its inputs. True when it may run: Pro, or free
  // tries left. With no tries left it shows the one explaining modal (user-started) and returns the unlock result.
  async function check(f) {
    if (pro()) { if (on) lic.refresh(); return true; }
    if (left(f) > 0) return true;
    return explain(f);
  }

  // Call after the action wrote its output. Uses one free try when the user is not Pro.
  async function commit(f) {
    if (pro() || !FEATURES[f]) return;
    const m = Object.assign({}, context.globalState.get(TRIAL_KEY) || {});
    m[f] = used(f) + 1;
    await context.globalState.update(TRIAL_KEY, m);
    const n = left(f);
    vscode.window.setStatusBarMessage('PDF Viewer: free try of ' + FEATURES[f].title.toLowerCase() + ' used, ' + n + ' left on this computer.', 6000);
  }

  // pdfViewer.showProFeatures = false hides the Pro button and commands (the "do not show again" for Pro).
  const shown = () => pro() || vscode.workspace.getConfiguration('pdfViewer').get('showProFeatures', true) !== false;

  return {
    enabled: on,
    shown,
    ready: lic.ready,
    check,
    commit,
    left,
    isPro: pro,
    label: (f) => (pro() ? '' : left(f) > 0 ? 'Pro, ' + left(f) + ' free ' + (left(f) === 1 ? 'try' : 'tries') : 'Pro'),
    onDidChange: (fn) => lic.onDidChange(fn),
    license: lic
  };
}

module.exports = { createPro, FEATURES, SKU, TRIAL_USES, TRIAL_KEY, PRO_ENABLED, PRICE_LINE };
