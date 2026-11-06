'use strict';
// Helpers for the "reload when the file changes on disk" watcher.
// RelativePattern takes a glob, so a file name such as `paper[1].pdf` or `notes{v2}.pdf` would not match
// itself. Each glob character becomes `?` (exactly one character), and events are then checked against
// the exact file name.
const path = require('path');

const GLOB_CHARS = /[[\]{}*?]/g;

/** Glob for one file name in its folder. Matches the name itself, and only names of the same length. */
function watchGlob(name) {
  return String(name).replace(GLOB_CHARS, '?');
}

/** True when a watcher event is about the file itself, not a look-alike that also matched the glob. */
function isSameFile(eventUri, name) {
  if (!eventUri || typeof eventUri.path !== 'string') return true;
  return path.posix.basename(eventUri.path) === name;
}

module.exports = { watchGlob, isSameFile };
