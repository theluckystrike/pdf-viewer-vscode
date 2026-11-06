'use strict';
// Integration test in a real VS Code. Uses an installed VS Code (no download) with a throwaway profile.
// Usage: node test/vscode/run.js ["/Applications/Visual Studio Code.app/Contents/MacOS/Code"]
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const code = process.argv[2] || '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
const ext = process.env.PDFV_EXT_DIR || path.join(__dirname, '..', '..');
fs.mkdirSync(path.join(os.homedir(), 'pdf-viewer-vscode-work'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.homedir(), 'pdf-viewer-vscode-work', 'vscode-it-'));
const user = path.join(tmp, 'user');
fs.mkdirSync(path.join(user, 'User'), { recursive: true });
fs.writeFileSync(path.join(user, 'User', 'settings.json'), JSON.stringify({
  'workbench.colorTheme': 'Default Dark Modern', 'telemetry.telemetryLevel': 'off', 'update.mode': 'none',
  'extensions.autoUpdate': false, 'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false,
}));
const ws = path.join(tmp, 'ws');
fs.mkdirSync(ws);
fs.copyFileSync(path.join(__dirname, '..', 'fixtures', 'sample.pdf'), path.join(ws, 'sample.pdf'));
fs.copyFileSync(path.join(__dirname, '..', 'fixtures', 'sample.pdf'), path.join(ws, 'paper[1] {v2}.pdf'));
const r = spawnSync(code, [
  '--user-data-dir', user, '--extensions-dir', path.join(tmp, 'exts'), '--disable-extensions', '--disable-gpu',
  '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--new-window',
  '--extensionDevelopmentPath=' + ext, '--extensionTestsPath=' + path.join(__dirname, 'suite.js'), ws,
], { stdio: 'inherit', timeout: 120000 });
fs.rmSync(tmp, { recursive: true, force: true });
console.log('VS Code exit code', r.status, r.error ? r.error.message : '');
process.exit(r.status === 0 ? 0 : 1);
