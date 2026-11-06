# Changelog

## 0.1.3 (2026-11-06)

- Listing only, no change to the extension. The display name is now "PDF Viewer & Reader with Dark Mode" and the description is one sentence, so the listing uses the words people search for (pdf viewer (34), pdf (not in top 100)).
- The 30 keywords start with the most searched terms.
- The README ends with links to the other Zovo extensions.

## 0.1.2 (2026-11-06)

- README opens with four real screenshots in light and dark themes, made from a report built on the real USGS earthquake catalog for October 2026, plus an installs badge and a version badge.
- The walkthrough uses its own smaller images, so the README screenshots stay out of the package (2.81 MB).
- Keywords updated. No change to the viewer itself. A run over 38 real PDFs (up to 2,000 pages) turned up no new bugs.
- The browser test can use an already running Chrome over CDP (`PDFV_CDP`), and `test/e2e/serve.js` takes the file name to show.

## 0.1.1 (2026-11-06)

- Shorter names in menus and the editor picker: "PDF Reader".

## 0.1.0 (2026-11-06)

First release. A read-only PDF editor built on pdf.js 5.7.284 (legacy build, bundled, no CDN).

- Dark pages that follow the VS Code theme and keep raster images in their colors, with a toggle per file.
- Find in PDF with highlights, match case, next and previous.
- Outline tree and page thumbnails in a sidebar. Zoom to fit width, fit page, or 50% to 400%.
- Reopens each PDF at the last page and zoom, and reloads when the file changes on disk, also for names with `[` or `{` in them.
- Asks before opening files over 200 MB. Supports password protected PDFs.

A PDF tab that you switch away from frees its rendered pages and draws them again when you come back, so many open PDFs use less memory.
