# Hunt Kit

Host threat-hunt and DFIR field reference: one method, the commands that run it, and offline tools to record the work. Built for a live Windows + Linux host investigation with Volatility, FTK and Autopsy.

Open `index.html` (works from GitHub Pages or straight off a USB stick, no server, no network). Press `/` to search every document at once.

## What's in it

| Path | What |
|---|---|
| `index.html` | Hub: cross-document search, document and tool links, five-questions reference pane |
| `docs/` | Rendered documents (generated from `src/`) |
| `pdf/` | Print versions of every document (generated) |
| `tools/hunt-notes.html` | Timeline / IOC / coverage notes. Converts any source time zone to UTC. Single file, offline |
| `tools/command-lens/` | Command Lens (beta): read-only one-liner builder for PowerShell, cmd, bash |
| `src/` | Markdown sources: **edit these** |
| `_build/` | Build script, site CSS/JS, PDF script |

Documents, in reading order:

1. **Two-Host Investigation Runbook**: rules, the five questions, decision gates, pre-flight, per-host sequence, time budget
2. **Execution Reference**: every command, tagged by question
3. **FTK Runbook** and **Autopsy Runbook**: linear disk investigations
4. **Sysinternals Reference**: what to read in each tool, with native fallbacks
5. **Analyst Methods Handbook**: collection planning, baselining, dashboards, intel-to-action, detection

## Rebuild after editing `src/`

Requires Python 3 + `beautifulsoup4`, pandoc, and (for PDFs) Node + Playwright.

```bash
python3 _build/build.py          # regenerates index.html, docs/, assets/
node _build/pdf.js               # regenerates pdf/ (headless Chromium)
```

## Ground rules

Defensive, authorized analysis only. Every live command in this kit is read-only. All recorded times are UTC.
