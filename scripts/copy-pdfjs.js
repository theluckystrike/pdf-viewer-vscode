'use strict';
// Copies the parts of pdfjs-dist the webview needs into media/pdfjs. Run after npm install.
// Uses the legacy build so it runs in the Chromium of older VS Code releases (engine ^1.90).
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'node_modules', 'pdfjs-dist');
const dst = path.join(root, 'media', 'pdfjs');
fs.rmSync(dst, { recursive: true, force: true });
fs.mkdirSync(dst, { recursive: true });
const copy = (from, to) => { fs.mkdirSync(path.dirname(path.join(dst, to)), { recursive: true }); fs.copyFileSync(path.join(src, from), path.join(dst, to)); };
copy('legacy/build/pdf.min.mjs', 'pdf.min.mjs');
copy('legacy/build/pdf.worker.min.mjs', 'pdf.worker.min.mjs');
copy('LICENSE', 'LICENSE');
for (const f of fs.readdirSync(path.join(src, 'cmaps'))) copy('cmaps/' + f, 'cmaps/' + f);
for (const f of fs.readdirSync(path.join(src, 'standard_fonts'))) copy('standard_fonts/' + f, 'standard_fonts/' + f);
// Image decoders (JPEG 2000, JBIG2) and color management. The scripting engine (quickjs) is left out on purpose.
for (const f of fs.readdirSync(path.join(src, 'wasm'))) {
  if (/^quickjs/.test(f)) continue;
  copy('wasm/' + f, 'wasm/' + f);
}
const version = require(path.join(src, 'package.json')).version;
fs.writeFileSync(path.join(dst, 'VERSION'), 'pdfjs-dist ' + version + ' (Apache-2.0), legacy build\n');
console.log('copied pdfjs-dist', version, 'to media/pdfjs');
