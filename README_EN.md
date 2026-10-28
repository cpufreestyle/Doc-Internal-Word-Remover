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
- Text: `txt`, `md`, `csv`, `tsv`, `json`, `xml`, `html`, `log`, `ini`, `yaml`, `sql`, and common source files

Legacy binary `doc`, `xls`, and `ppt` files and PDFs must first be saved in a supported format.

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
