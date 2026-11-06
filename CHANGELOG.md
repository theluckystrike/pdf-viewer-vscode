# Changelog

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
