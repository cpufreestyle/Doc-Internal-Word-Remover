# Document Sensitive Term Remover

> Made by michaelqiu

A local-first desktop web app and command-line tool for scanning and removing sensitive terms from Word, Excel, PowerPoint, and text files. Documents are processed on the local machine and are never uploaded.

## Features

- Scan directories, drives, or imported report lists.
- Match the first line, last line, or the full document.
- Delete, mask, or replace matched terms.
- Process OOXML content including headers, comments, tracked changes, metadata, chart caches, and embedded Office files.
- Preview matches, verify cleaned output, and export JSON, CSV, or HTML reports.
- Review large result sets with filters, range selection, false-positive controls, and a manual review checklist.
- Import JSON reports, HTML tables from generic checking tools, or plain path lists.

## Quick start

On Windows, extract the release archive and run `启动工具.exe` or `Start.bat`. The page opens at `http://127.0.0.1:8080/index.html`. You can also open `index.html` directly in Chrome or Edge.

On Linux or UOS:

```bash
bash Start.sh
```

The startup scripts bind only to `127.0.0.1`, so other devices on the network cannot access the local service.

## Report mode

Report paths are treated as untrusted input. Always provide one or more explicit authorized roots:

```bash
node scan.mjs --from-report report.json \
  --authorized-root "/home/user/Documents" \
  --out cleaned
```

Delete is a dry run by default. Add `--confirm-delete` only after reviewing the plan:

```bash
node scan.mjs --from-report report.json \
  --authorized-root "/home/user/Documents" \
  --delete --confirm-delete
```

Network paths are rejected unless both `--allow-network-paths` and `--confirm-network-paths` are present.

## Supported formats

- Word: `docx`, `docm`, `dotx`, `dotm`
- Excel: `xlsx`, `xlsm`, `xltx`, `xltm`
- PowerPoint: `pptx`, `pptm`, `potx`, `potm`, `ppsx`, `ppsm`
- PDF: `pdf` (content streams decompressed and glyphs mapped back to text; read-only detection; image-only scans are tagged "scanned" for manual review)
- Archives: `zip`, `jar`, `apk`, `epub` (entries unpacked and inspected; read-only detection)
- Text: `txt`, `md`, `csv`, `tsv`, `json`, `xml`, `html`, `log`, `ini`, `yaml`, `sql`, and common source files

Legacy binary `doc`, `xls`, and `ppt` files, along with `pdf`, `rtf`, and `zip`, support **read-only detection** (sensitive words can be found, but the file cannot be rewritten in place). Convert them to a supported OOXML format before cleaning. `rar`, `7z`, and disk images cannot be unpacked; only their file names are checked.

## Scan coverage and unchecked files

- Results report files traversed, files actually inspected, hits, detection-only files, and unchecked files separately, so "no hit" is never confused with "not scanned".
- Unchecked files are grouped by reason: unsupported format, size limit, read failure, filename filter, file-count limit, or directory permission.
- The results card includes an expandable unchecked list with sample paths and a CSV export; CSV / JSON / HTML reports also record the counts and reasons.

## Hit location traceability

- Every hit is recorded per package part, for example `Notes (ppt/notesSlides/notesSlide1.xml) x 2 hits: Secret` or `Document properties (docProps/core.xml) x 1 hit: Classified`.
- Classification markers often live in speaker notes, charts, document properties, shape names, or embedded objects, where they are invisible in the body text.
- Coverage includes all OOXML text parts, attribute values, charts, comments, footnotes, endnotes, custom XML, embedded Office documents, and ZIP entry names.
- In the web UI, hover the hit word in the scan table to see the location; the preview panel lists every part below the hit badges. All three exported reports carry a location column.
- The CLI adds a `parts` column to CSV, a location column to the HTML index, and a `Location` line to each per-file hit log.

## What counts as detected

External confidentiality checkers search the file name plus the full unpacked package, not just the first and last lines of the body. Detection here matches that:

- **File names count as hits**: a file named `Secret contract.docx` is reported even when its body is clean. The location is shown as "file name" and only the name is tested, never the directory.
- **Both UTF-16 byte alignments are inspected** for legacy `doc` / `xls` / `ppt`: text in an OLE2 container is UTF-16 but not guaranteed to start on an even byte, so half of a file can be unreadable otherwise. Such hits are labelled "OLE misaligned".
- **Namespace-prefixed OOXML is readable**: some online tools export sheets as `<x:c><x:v>`. Block patterns written for unprefixed tags match nothing and the whole part is silently skipped; a text-node fallback now covers it in scan, clean, and preview alike.
- **PDF text is read**: built-in DEFLATE decompression plus `/ToUnicode` glyph mapping cover compressed content streams and text inside form XObjects (headers and watermarks often live there). Whitespace between CJK characters is collapsed, so justified headings such as `内 部` still match. Pages packed into `/ObjStm` object streams are expanded, and permission-only encryption with an empty user password (RC4 / AES-128) is decrypted through the standard security handler. Image-only (scanned) PDFs are explicitly tagged "scanned" and counted separately in the summary — no OCR, no guessing, manual review required. Scanned PDFs with zero hits still appear in the unchecked list and in a dedicated "scanned PDF" section of the HTML index, so they never disappear just because no word matched; damaged files and AES-256 PDFs fall back to "file name only", and the location column always says why.
- **Archives are unpacked**: `zip`, `jar`, and `apk` are inspected entry by entry, documents inside are parsed by their own format, entry names count as hits, and locations carry the in-package path. `rar` and `7z` have no decoder here, so only their file names are checked and the report says so.
- **Document numbers require a bracketed year**: only the full form such as `Guofa [2023] No. 5` counts. Matching the bare prefix would delete ordinary words mid-sentence. Words passed explicitly through `--words` keep plain matching.
- The post-clean self-check also re-tests the output file name and asks for a rename when it still contains a marker (renaming is left to the user because links and references would break).

## Security

- No third-party runtime dependencies or external web requests.
- Startup scripts explicitly bind to the loopback interface.
- Report-derived source paths are canonicalized and checked against explicit roots.
- ZIP and OOXML processing enforce entry, archive, recursion, byte, and time budgets.

Please report security issues privately and never attach real documents or checking reports to a public issue.

## Development

Node.js 18 or newer is required.

```bash
npm test
node test-e2e.mjs
```

The Playwright smoke test requires Chromium.

## License

MIT License. Copyright (c) 2026 cpufreestyle (michaelqiu).
