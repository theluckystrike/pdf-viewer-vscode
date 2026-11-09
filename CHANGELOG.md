# Changelog

## 0.2.13 (2026-11-09)

- "Rate it" in the rating question and the Rate link in the viewer footer now open the review page of the store your editor installs from: the Visual Studio Marketplace in VS Code, Open VSX in Cursor, Windsurf, VSCodium and other editors that use Open VSX. Before, they always opened the Marketplace.
- A window that stays open for days now counts a file opened 4 hours or more after its first one as a new session for the rating question.
- Nothing else changed: files open and look the same.

## 0.2.11 (2026-11-09)

- The Marketplace name is now "PDF Viewer & PDF Reader to Read and View PDF (Dark Mode)" (was "PDF Viewer & Reader to Read and View PDF in Dark Mode"). It brings back the exact words PDF Reader and keeps Read, View PDF and Dark Mode. The extension ID, settings and commands stay the same.
- No change to how files open or look.

## 0.2.10 (2026-11-08)

- The Marketplace name is now "PDF Viewer & Reader to Read and View PDF in Dark Mode" (was "PDF Viewer & PDF Reader"), so more searches find it. The extension ID, settings and commands stay the same.
- The short description now starts with what the name does not say: free and offline, with sepia pages and highlights you can copy as Markdown.
- A brighter icon with the file type on it, easier to spot in the Extensions view.
- The viewer footer now starts with Rate, then More free viewers, Sponsor and Hide. The rating question comes after 2 files that opened without an error in 2 sessions at least 4 hours apart.

## 0.2.9 (2026-11-08)

- Search and text selection now work in VS Code 1.90 and 1.91 and in older Cursor, Windsurf and VSCodium builds that are based on them. Before, the pages showed but the text layer did not load there.

## 0.2.8 (2026-11-08)

- A PDF that a build tool is still writing no longer flashes "This file is not a valid PDF". The last version stays on screen, with a note in the status bar, until the new file can be read. After the reload you are on the same page, at the same zoom and scroll position (before, the scroll position inside the page was lost).
- If a reload opens a half-written file with fewer pages, the next reload goes back to the page you were on.
- The README says what the viewer does when the PDF changes and which keys it uses.
- The rating question now comes after 3 files that opened without an error on 2 different days, and never after an error. "Later" asks one more time after 7 days, "No thanks" ends it, and it never asks more than 2 times. `pdfViewer.askForRating: false` turns it off.

## 0.2.7 (2026-11-08)

- The "More free viewers" list and the README now use the current Marketplace names and include the newest Zovo extensions: ZIP, GCode, EPUB, HAR, font and audio viewers.

## 0.2.6 (2026-11-07)

- The Marketplace page shows the Markdown examples as written. The page links in the "Copy as Markdown" sample and the `docs/paper.pdf#page=12` example were turned into GitHub links to files that do not exist.

## 0.2.5 (2026-11-07)

- Highlights. Select text in a PDF and pick yellow, green, blue or pink from the bar under the selection, or press `H`. A new Highlights tab in the sidebar lists them by page. A click jumps to one, × removes it. They are saved in VS Code for each file, and the PDF file is not changed.
- "Copy as Markdown" in the Highlights tab, and "PDF: Copy Highlights as Markdown" in the Command Palette, copy the highlights as a Markdown list with a link to each page.
- Sepia pages. The new paper button in the toolbar, or "PDF: Toggle Sepia Pages", shows light pages in warm paper colors. Photos keep their colors. The new setting `pdfViewer.lightPages` (`white` or `sepia`) picks the default.
- The Marketplace name is now "PDF Viewer & PDF Reader". The extension ID, settings and commands stay the same.

## 0.2.4 (2026-11-07)

- "More free viewers" now starts with the Zovo extensions most related to this one. Picking one opens its Marketplace page, where you choose to install it.
- The README has a "Support Zovo" section with GitHub Sponsors and the developer's GitHub profile, and "More tools by Zovo" lists related extensions.

## 0.2.3 (2026-11-07)

- The footer under the viewer has a "Rate" link next to Sponsor and More free viewers. It opens the review page of this extension on the Marketplace. Nothing pops up and nothing asks you for a rating. "Hide" still hides the whole line.

## 0.2.2 (2026-11-07)

- The "More free viewers" list and the README list now show the 15 Zovo extensions on the Marketplace under their current names, and 12 that are coming soon.
- Extensions for related files now come first, starting with DOCX Viewer & Word Viewer with Dark Mode and CSV Viewer, Excel Viewer & Parquet Viewer.

## 0.2.1 (2026-11-07)

- The Marketplace name is now "PDF Viewer & PDF Reader with Dark Mode", so a search for PDF reader finds it. The extension ID, settings and commands stay the same.

## 0.2.0 (2026-11-06)

- Markdown links can open a PDF at a page, as in a browser. `[paper](docs/paper.pdf#page=12)` in a `.md` file opens page 12 when you click it in the Markdown preview. `#nameddest=results` opens a named destination and `&zoom=150` sets the zoom. The link sets the page only when the PDF opens. After that, the last page you read is remembered per file as before.
- New command "PDF: Copy Link to This Page" copies a Markdown link to the page you are reading. Inside a workspace the link starts with `/` from the workspace folder, so it works from any note in it.
- New command "PDF: Go to Page..." with `Ctrl+G`. It checks that the page exists before it jumps.
- New setting `pdfViewer.sidebar`. `closed` (the default) keeps the outline and pages sidebar closed until you open it, also for LaTeX PDFs with bookmarks. `open` opens it for every PDF, and `remember` keeps the way you left it in the last PDF.
- All of this is free, like the rest of the extension. Nothing is sent anywhere.

## 0.1.6 (2026-11-06)

- The Marketplace page now starts with a screenshot of a real VS Code window with dark pages, the outline and a search, and a short GIF of opening a PDF, searching and switching dark pages. Both were made from generated sample files. The images load from the GitHub repo and are not packed into the extension, so the download size stays the same.

## 0.1.5 (2026-11-06)

- A small line at the bottom right of the viewer has two links, "Sponsor" (GitHub Sponsors) and "More free viewers". The new setting `pdfViewer.showSupportLinks` (default `true`) hides it, and so does the "Hide" link next to them. There is no popup, and nothing is sent anywhere.
- New commands "PDF: Support the developer" and "PDF: More free viewers". The second one lists the other Zovo extensions and installs only the one you pick. Ones that are not on the Marketplace yet open their GitHub page.
- The listing gets a Sponsor button. The README has a short Support section and lists all Zovo extensions.

## 0.1.4 (2026-11-06)

- PDF Viewer asks one time for a Marketplace rating. It counts each success (an opened PDF). After 5 of them, and no sooner than 2 days after the first, it shows a small message with "Rate it", "Later" and "Don't ask again". "Later" waits for 20 more, at most two more times. It never shows in your first session, more than once per session, when the window is not focused, or in a remote or untrusted workspace.
- New setting `pdfViewer.askForRating` (default `true`) turns it off. Nothing is sent anywhere; "Rate it" only opens the review page in your browser.

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

- Shorter names in menus and the editor picker. They now say "PDF Reader".

## 0.1.0 (2026-11-06)

First release. A read-only PDF editor built on pdf.js 5.7.284 (legacy build, bundled, no CDN).

- Dark pages that follow the VS Code theme and keep raster images in their colors, with a toggle per file.
- Find in PDF with highlights, match case, next and previous.
- Outline tree and page thumbnails in a sidebar. Zoom to fit width, fit page, or 50% to 400%.
- Reopens each PDF at the last page and zoom, and reloads when the file changes on disk, also for names with `[` or `{` in them.
- Asks before opening files over 200 MB. Supports password protected PDFs.

A PDF tab that you switch away from frees its rendered pages and draws them again when you come back, so many open PDFs use less memory.
