# Command Lens

Build correct host-analysis and threat-hunting one-liners for **bash, zsh, PowerShell 5.1/7 and cmd**, see what every token does, and reuse them against new IOC sets. Part of the Lens family (EVTX Lens, Recall Lens, Timeline Lens, Plan Lens, Type Lens).

![Command Lens: a Get-WinEvent → Where-Object → Select-Object chain bound to an IOC set](docs/screenshot.png)

- **Offline and private.** One static page. It runs from `file://` or GitHub Pages, makes no network requests (the page's Content-Security-Policy blocks them), and keeps all data in your browser profile.
- **Correct first.** Every value is quoted for the target shell by a tested quoting layer. A line that cannot be quoted safely (for example an odd number of `"` in a cmd argument) is refused, not emitted.
- **Explained.** Hover any token to see what it does. A plain-language summary, the ATT&CK techniques hunted, elevation needs and OPSEC notes update as you type.
- **Reusable.** Every copied line goes to history as structured state. Promote a line to a **recipe** and its IOC fields become variables you can re-run against another case.

## Quick start

1. Open `index.html` in Chrome or Edge (double-click works), or use the hosted copy.
2. Pick the shell in the top bar. For PowerShell, also pick **5.1** or **7**.
3. Press **Ctrl+K** and type a tool (`grep`, `Get-WinEvent`, `netstat`), a task (`scheduled task`) or an ATT&CK ID (`T1053.005`). Enter adds it, and presets fill the form.
4. Under the last command, the **Add next** buttons show every operator the shell has: `|` pipe into…, `&&` if it worked…, `||` if it failed…, `;` (cmd: `&`) then…. Pick one, then pick the tool. The operator between two commands can be changed later in the dropdown between them. On PowerShell 5.1, `&&`/`||` are written as `; if ($?) { … }` automatically.
5. **Nested commands & expressions:** `find` builds a full test expression (AND/OR, `!`, groups) and runs read-only commands on matches (`-exec grep … {} +`); `xargs`, `sudo` and `timeout` wrap a command. Each nested command gets its own card and shows in the **Structure** outline. Any regex field has a **Regex ⍰** button that explains the pattern token by token, flags the common mistakes (an unescaped dot in an IP, a findstr `|`), and tests it on sample lines.
6. **Conditions with `{ }`:** in PowerShell, search `?` or `{ }` for **Where-Object { }** (a script-block condition with `$_`, `-and`, `-or`, `-not`) and `%` for **ForEach-Object { }**. Presets cover common hunts (system process names in the wrong folder, svchost with the wrong parent, unsigned files, external connections). The block is your PowerShell code: Command Lens checks that its brackets and quotes balance and refuses it if they do not, but does not re-quote inside it.
7. **Ctrl+Enter** copies. The copy menu also offers *Line + summary*, a *Markdown block* for Obsidian, and a *Timeline Lens row* (TSV that Timeline Lens bulk paste maps automatically).

### IOCs

**IOC sets → Paste report → extract IOCs** takes a report, e-mail or CSV. It re-fangs `hxxp` / `[.]`, types each value (IPv4/6, domain, URL, hashes, paths, registry keys, users, SIDs, e-mail, process names) and shows a review table before anything is saved. Any field with an **IOC ▾** button can then take one value or **all values of a type**, in one of four forms:

| Form | bash | PowerShell | cmd |
|---|---|---|---|
| all in one command (default, fixed strings) | `grep -F -e a -e b` | `-In -Value 'a','b'` / `-SimpleMatch -Pattern a,b` | `findstr /c:a /c:b /l /i` |
| one regex | `grep -E 'a\|b'` (escaped) | `-Match 'a\|b'` | n/a (findstr has no `\|`) |
| loop | `for ioc in …; do …; done` | `foreach ($ioc in @(…)) { … }` | `for %i in (…) do (…)` |
| one line per IOC | N lines | N lines | N lines |

Fixed strings are the default because IOCs are literal: in a regex, `198.51.100.23` also matches `198x51y100z23`.

## Keyboard

| Key | Action |
|---|---|
| Ctrl+K | Find a tool, preset, technique, recipe or action |
| Ctrl+Enter | Copy the line (saved to history) |
| Ctrl+S | Save with tags and pin |
| Alt+↑ / Alt+↓ | Move the current command |
| Ctrl+D / Ctrl+/ / Ctrl+Delete | Duplicate / skip / delete the current command |
| Ctrl+1…4 | Switch shell |
| / | Filter history (`tool:grep tag:case1 ioc:198.51 T1053`) |

## Your data

History, recipes, IOC sets, your paths and your imported tool files live in **IndexedDB in this browser profile only**. Small settings live in localStorage. Nothing is uploaded, and the hosted page cannot make network requests. **Data → Export workspace** writes everything to one JSON file; treat it like case data, because it contains your IOCs. **Data → Clear all local data** removes everything (you type `CLEAR` to confirm). If the browser blocks storage (private window, policy), a red pill says nothing is being saved.

## Develop

No dependencies. Node 18+ for the scripts and tests.

```sh
node scripts/bundle.js          # rebuild js/data.bundle.js after editing shells/ tools/ paths/ ttps/
node scripts/validate.js        # check every data file (or name one file)
node scripts/coverage.js        # flag coverage of Linux tools vs the installed binaries (informational)
node tests/run.js               # 112 engine tests: quoting, bash/zsh round trips, cmd model, golden one-liners
node tests/e2e.js               # browser tests (needs Playwright; not a project dependency)
node scripts/import-attack.js enterprise-attack-NN.N.json   # refresh the ATT&CK index
```

On a Windows host, run `tests/windows/roundtrip.ps1` once in **powershell.exe** and once in **pwsh**. It replays the quoting cases through real PowerShell and cmd.exe, which cannot run in CI.

- Add a tool, shell, path or ATT&CK mapping: [docs/EXTENDING.md](docs/EXTENDING.md). It is a data file, not a code change.
- How it is built and why: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (quick map) and [docs/DESIGN.md](docs/DESIGN.md) (full rationale).
- Status, known limitations and next steps: [docs/STATUS.md](docs/STATUS.md).

## Licence

Apache-2.0, © 2026 pearmanref. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

Tool and flag descriptions are written for this project; each tool file links its source documentation. ATT&CK data: © The MITRE Corporation, reproduced and distributed with the permission of The MITRE Corporation.
