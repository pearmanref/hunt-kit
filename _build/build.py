#!/usr/bin/env python3
"""Build the hunt-kit site: src/*.md -> docs/*.html + assets/search-index.js + index.html (+ pdf/)."""
import json, re, subprocess, sys, html, shutil, pathlib
from bs4 import BeautifulSoup

HERE = pathlib.Path(__file__).resolve().parent          # _build/
ROOT = HERE.parent                                       # repo root
OUT = pathlib.Path(sys.argv[1]).resolve() if len(sys.argv) > 1 and not sys.argv[1].startswith('--') else ROOT
SRC = ROOT / 'src'
MAKE_PDF = False  # PDFs: node _build/pdf.js (headless Chromium, honors print CSS)

DOCS = [  # slug, source, title, group, blurb
 ('investigation-runbook','Investigation-Runbook.md','Two-Host Investigation Runbook','Start here','Rules, five questions, gates, pre-flight, per-host sequence, time budget, tear-off.'),
 ('execution-reference','Execution-Reference.md','Execution Reference','Execution','Every command: Windows + Linux live triage, native execution artifacts, Volatility 3/2, FTK, Autopsy, KQL, Suricata, Zeek.'),
 ('ftk-runbook','FTK-Runbook.md','FTK Runbook','Execution','Linear FTK Imager + FTK investigation, step by step against Q1–Q5.'),
 ('autopsy-runbook','Autopsy-Runbook.md','Autopsy Runbook','Execution','Linear Autopsy investigation, step by step against Q1–Q5, incl. timeline and $SI/$FN.'),
 ('sysinternals','Sysinternals-Reference.md','Sysinternals Reference','Execution','Autoruns, Sigcheck, TCPView, Process Explorer, ListDLLs, Handle, Streams… what to read in each, with native fallbacks.'),
 ('methods-handbook','Analyst-Methods-Handbook.md','Analyst Methods Handbook','Method','Collection plan, baseline, dashboards, intel-to-action crosswalk, detection & filter pack, ICS/SCADA.'),
]
TOOLS = [
 ('tools/hunt-notes.html','Hunt Notes','Drop in observations, convert any time zone to UTC, build the timeline, IOC list and coverage grid. Exports MD/CSV/JSON.'),
 ('tools/command-lens/index.html','Command Lens (beta)','Build read-only one-liners for PowerShell, cmd, bash from forms; explains every token.'),
]

def rail_html():
    s = (ROOT/'tools'/'hunt-notes.html').read_text(encoding='utf-8')
    m = re.search(r'<!--RAIL-START-->(.*)<!--RAIL-END-->', s, re.S)
    return m.group(1)

def slugify(t, used):
    b = re.sub(r'[^a-z0-9]+','-', t.lower()).strip('-')[:60] or 'section'
    s, n = b, 2
    while s in used: s = f'{b}-{n}'; n += 1
    used.add(s); return s

def render(md):
    r = subprocess.run(['pandoc','-f','gfm','-t','html5','--no-highlight'], input=md, capture_output=True, text=True, check=True)
    return r.stdout

index, pages = [], []
for slug, src, title, group, blurb in DOCS:
    md = (SRC/src).read_text(encoding='utf-8')
    soup = BeautifulSoup(render(md), 'html.parser')
    first_h1 = soup.find('h1'); page_h1 = title
    if first_h1 and first_h1 is soup.find(True):
        page_h1 = first_h1.get_text(' ', strip=True); first_h1.decompose()
    used, toc = set(), []
    heads = soup.find_all(re.compile('^h[1-4]$'))
    for h in heads:
        h['id'] = slugify(h.get_text(' ', strip=True), used)
        lvl = int(h.name[1])
        if lvl <= 3: toc.append((lvl, h['id'], h.get_text(' ', strip=True)))
    # sections for search: text between consecutive headings
    body_nodes = list(soup.children)
    cur = {'h': title, 'id': '', 'lvl': 0, 'txt': []}; crumbs = {}
    secs = [cur]
    for node in body_nodes:
        if getattr(node, 'name', None) and re.match('^h[1-4]$', node.name):
            lvl = int(node.name[1]); crumbs[lvl] = node.get_text(' ', strip=True)
            for k in list(crumbs):
                if k > lvl: del crumbs[k]
            cur = {'h': node.get_text(' ', strip=True), 'id': node['id'], 'lvl': lvl,
                   'path': ' › '.join(crumbs[k] for k in sorted(crumbs) if k < lvl), 'txt': []}
            secs.append(cur)
        else:
            t = node.get_text(' ', strip=True) if hasattr(node, 'get_text') else str(node).strip()
            if t: cur['txt'].append(t)
    for s in secs:
        txt = re.sub(r'\s+', ' ', ' '.join(s['txt'])).strip()
        if not txt and not s['id']: continue
        index.append({'d': title, 's': slug, 'a': s['id'], 'h': s['h'], 'p': s.get('path',''), 't': txt[:6000]})
    pages.append((slug, title, group, blurb, str(soup), toc, page_h1))

OUT.mkdir(parents=True, exist_ok=True)
for d in ('docs','assets','pdf','tools'): (OUT/d).mkdir(exist_ok=True)
(OUT/'assets'/'search-index.js').write_text('window.SEARCH_INDEX=' + json.dumps(index, ensure_ascii=False, separators=(',',':')) + ';\nwindow.SEARCH_DOCS=' + json.dumps([{'s':p[0],'t':p[1]} for p in pages]) + ';\n', encoding='utf-8')
shutil.copy(HERE/'assets'/'site.css', OUT/'assets'/'site.css')
shutil.copy(HERE/'assets'/'site.js', OUT/'assets'/'site.js')
RAIL = rail_html()

HEAD = '''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title><link rel="stylesheet" href="{b}assets/site.css"></head>'''

def topbar(b, title, pdf=None):
    pdfl = f'<a class="btn" href="{b}pdf/{pdf}.pdf" title="Printable PDF">PDF</a>' if pdf else ''
    return f'''<header class="top"><a class="brand" href="{b}index.html">Hunt Kit</a><span class="crumb">{html.escape(title)}</span>
<div class="search"><input id="q" type="search" placeholder="Search everything  ( / )" autocomplete="off"><div id="results" class="results" hidden></div></div>
<a class="btn" href="{b}tools/hunt-notes.html" target="_blank">Hunt Notes</a>{pdfl}
<button class="btn" id="tocBtn" title="Contents">☰</button><button class="btn" id="railBtn" title="Questions pane">Q</button><button class="btn" id="themeBtn" title="Theme">◐</button></header>'''

for slug, title, group, blurb, body, toc, page_h1 in pages:
    tochtml = ''.join(f'<a class="l{l}" href="#{i}">{html.escape(t)}</a>' for l, i, t in toc)
    page = HEAD.format(title=html.escape(title), b='../') + f'''<body data-base="../" class="doc">
{topbar('../', title, slug)}
<div class="layout"><nav id="toc" class="toc"><div class="toch">Contents</div>{tochtml}</nav>
<main class="content"><h1>{html.escape(page_h1)}</h1>{body}</main>
<aside id="rail" class="rail">{RAIL}</aside></div>
<script src="../assets/search-index.js"></script><script src="../assets/site.js"></script></body></html>'''
    (OUT/'docs'/f'{slug}.html').write_text(page, encoding='utf-8')

# hub
groups = {}
for p in pages: groups.setdefault(p[2], []).append(p)
cards = ''
for g in ['Start here','Execution','Method']:
    cards += f'<h2>{g}</h2><div class="cards">' + ''.join(
        f'<a class="card" href="docs/{s}.html"><b>{html.escape(t)}</b><span>{html.escape(bl)}</span><em>PDF ↗</em></a>'.replace('<em>PDF ↗</em>', '') for s,t,_,bl,_,_,_ in groups.get(g,[])) + '</div>'
cards += '<h2>Tools</h2><div class="cards">' + ''.join(f'<a class="card tool" href="{u}" target="_blank"><b>{html.escape(t)}</b><span>{html.escape(bl)}</span></a>' for u,t,bl in TOOLS) + '</div>'
cards += '<h2>Print</h2><div class="cards pdfs">' + ''.join(f'<a class="card small" href="pdf/{s}.pdf"><b>{html.escape(t)}</b><span>PDF</span></a>' for s,t,*_ in pages) + '</div>'
hub = HEAD.format(title='Hunt Kit', b='') + f'''<body data-base="" class="hub">
{topbar('', 'Home')}
<div class="layout hubl"><main class="content">
<section class="hero"><h1>Hunt Kit</h1><p>Host threat-hunt and DFIR reference: one method, the commands that run it, and the tools to record it. Search finds any command, artifact or step across every document. Press <kbd>/</kbd>.</p>
<div class="bigsearch"><input id="q2" type="search" placeholder="e.g. netscan · amcache · 4648 · systemd enabled · timestomp" autocomplete="off"><div id="results2" class="results inline" hidden></div></div></section>
{cards}
<p class="foot">Defensive, authorized analysis only. Every live command is read-only. All times recorded in UTC.</p>
</main><aside id="rail" class="rail">{RAIL}</aside></div>
<script src="assets/search-index.js"></script><script src="assets/site.js"></script></body></html>'''
(OUT/'index.html').write_text(hub, encoding='utf-8')
(OUT/'.nojekyll').write_text('')
print('sections indexed:', len(index), 'pages:', len(pages))

if MAKE_PDF:
    for slug, title, *_ in pages:
        subprocess.run(['wkhtmltopdf','-q','--enable-local-file-access','--print-media-type','--encoding','utf-8',
            '--page-size','Letter','-T','14mm','-B','14mm','-L','12mm','-R','12mm',
            '--footer-font-size','8','--footer-right','[page] / [topage]','--footer-left',title,
            str(OUT/'docs'/f'{slug}.html'), str(OUT/'pdf'/f'{slug}.pdf')], check=False)
    print('pdfs:', sorted(p.name for p in (OUT/'pdf').glob('*.pdf')))
