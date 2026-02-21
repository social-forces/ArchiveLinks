# ArchiveLinks

A static browser application that helps authors preserve cited web pages in the Internet Archive (Wayback Machine) before publication.

## What it does

1. Accepts manuscript upload (`.pdf` or `.docx`).
2. Extracts all external HTTP(S) links locally in the browser.
3. Opens a step-by-step review stage with manual link add and per-link skip/include control.
4. Defaults to archiving all extracted links except DOI links, which are auto-skipped.
5. Lets users toggle each link between `Skip` and `Include` without removing it from the list.
6. Sends included links to Wayback's **Save Page Now** endpoint (bounded parallel workers).
7. Supports retrying unresolved included links without reprocessing already archived ones.
8. Polls Wayback availability for archived snapshot URLs with timeout/error handling.
9. Exports a CSV of original links, archive links, inclusion state, and skip reason.

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

Documentation page: [http://localhost:8000/docs.html](http://localhost:8000/docs.html).

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
