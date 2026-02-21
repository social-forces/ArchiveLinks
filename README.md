# ArchiveLinks

A static browser application that helps authors preserve cited web pages in the Internet Archive (Wayback Machine) before publication.

## What it does

1. Accepts manuscript upload (`.pdf` or `.docx`).
2. Extracts all external HTTP(S) links locally in the browser.
3. Opens a review stage where users can remove extracted links and add missing URLs manually.
4. Sends each reviewed link to Wayback's **Save Page Now** endpoint.
5. Polls Wayback availability for archived snapshot URLs.
6. Exports a CSV of original links and preserved archive links.

## Why this architecture

- No backend required.
- Easy hosting on a departmental static site.
- Manuscript content stays local in the user's browser.

## Run locally

Because ES modules are used, serve the folder over HTTP:

```bash
cd /Users/nealcaren/Documents/GitHub/wayback-frontend
python3 -m http.server 8000
```

Then open [http://localhost:8000](http://localhost:8000).

## Notes and limitations

- Wayback indexing is asynchronous. A save request may succeed but not appear immediately.
- Entries marked `not yet indexed` can be retried after a short wait.
- PDF extraction relies on explicit hyperlink annotations in the PDF (common in exported manuscripts).
- DOCX extraction uses hyperlink tags parsed via Mammoth.
- Some target websites may block archiving.

## Output format

CSV columns:

- `original_url`
- `preserved_link`
- `status`
