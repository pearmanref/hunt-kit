/* L4 — the drawer under the builder: History, Recipes, IOC sets, Paths, Data.
 * Reuse is the third priority, so it sits below the builder and stays out of the way. */
(function (root) {
  'use strict';
  const CL = (root.CL = root.CL || {});
  const ui = (CL.ui = CL.ui || {});
  const h = (...a) => ui.h(...a);

  let app = null;
  let tab = 'history';
  let selSet = null;

  // ---------------------------------------------------------------- filter
  /** "tool:grep tag:case1 ioc:198.51 T1053 free text" → predicate over a history/recipe record */
  function parseFilter(q) {
    const f = { text: [], tool: [], tag: [], ioc: [], tech: [] };
    for (const w of String(q || '').trim().split(/\s+/).filter(Boolean)) {
      const m = /^(tool|tag|ioc):(.+)$/i.exec(w);
      if (m) f[m[1].toLowerCase()].push(m[2].toLowerCase());
      else if (/^t\d{4}(\.\d{3})?$/i.test(w)) f.tech.push(w.toUpperCase());
      else f.text.push(w.toLowerCase());
    }
    return (r) => {
      const hay = `${r.text} ${r.summary || ''} ${r.note || ''} ${r.name || ''}`.toLowerCase();
      if (!f.text.every((t) => hay.includes(t))) return false;
      if (!f.tool.every((t) => (r.tools || []).some((x) => x.toLowerCase().includes(t)))) return false;
      if (!f.tag.every((t) => (r.tags || []).some((x) => x.toLowerCase().includes(t)))) return false;
      if (!f.ioc.every((t) => (r.iocs || []).some((x) => String(x.value).toLowerCase().includes(t)))) return false;
      if (!f.tech.every((t) => (r.ttps || []).some((x) => x === t || x.startsWith(t + '.')))) return false;
      return true;
    };
  }

  // ---------------------------------------------------------------- history
  function renderHistory() {
    const box = ui.clear(ui.$('#tab-history'));
    const pred = parseFilter(ui.$('#drawerSearch').value);
    const list = app.history.filter(pred).sort((a, b) => (b.pinned - a.pinned) || b.ts.localeCompare(a.ts));
    box.append(h('div.toolbar',
      h('span.muted.small', { text: `${list.length} of ${app.history.length} saved line${app.history.length === 1 ? '' : 's'}. Every copy is saved here automatically.` }),
      h('button.btn.ghost', { text: 'Clear unpinned', onclick: async () => {
        const ok = await ui.modal('Clear unpinned history?', h('p', { text: 'Pinned lines and recipes are kept.' }), [{ label: 'Cancel', value: false }, { label: 'Clear', value: true, danger: true }]);
        if (ok) { for (const x of app.history.filter((y) => !y.pinned)) await app.deleteHistory(x.id); render(); }
      } })));
    if (!list.length) { box.append(h('p.empty', { text: app.history.length ? 'Nothing matches the filter.' : 'Lines you copy or save appear here, with the tools, IOCs and ATT&CK IDs they used.' })); return; }
    const ul = h('ul.hist');
    for (const r of list.slice(0, 300)) {
      ul.append(h('li',
        h('button.icon-btn.pin' + (r.pinned ? '.on' : ''), { text: r.pinned ? '★' : '☆', title: r.pinned ? 'Unpin' : 'Pin', onclick: async () => { r.pinned = !r.pinned; await app.saveHistory(r); render(); } }),
        h('div',
          h('div.cmd', { text: r.text, title: 'Load into the builder', onclick: () => app.loadState(r.state) }),
          h('div.sub', h('span.when', { text: ui.fmtTime(r.ts) + '  ' }), (r.tags || []).map((t) => h('span.tag', { text: '#' + t })),
            h('span', { text: `${r.shell} · ${(r.ttps || []).join(' ') || 'no ATT&CK mapping'}${r.iocs && r.iocs.length ? ` · ${r.iocs.length} IOC value${r.iocs.length > 1 ? 's' : ''}` : ''}${r.note ? ' · ' + r.note : ''}` }))),
        h('div.acts',
          h('button.icon-btn', { text: '⎘', title: 'Copy line', onclick: async () => { await ui.copyText(r.text); ui.toast('Copied'); } }),
          h('button.icon-btn', { text: '#', title: 'Tags and note', onclick: () => editTags(r) }),
          h('button.icon-btn', { text: '⇢R', title: 'Make a recipe (IOC values become variables)', onclick: () => promote(r) }),
          h('button.icon-btn', { text: '✕', title: 'Delete', onclick: async () => { await app.deleteHistory(r.id); render(); } }))));
    }
    box.append(ul);
  }

  async function editTags(r) {
    const tags = h('input', { type: 'text', value: (r.tags || []).join(' '), placeholder: 'case-0314 persistence' });
    const note = h('input', { type: 'text', value: r.note || '', placeholder: 'Note' });
    const ok = await ui.modal('Tags and note', h('div.fgrid', h('div.field', h('label', { text: 'Tags (space-separated)' }), tags), h('div.field', h('label', { text: 'Note' }), note)), [{ label: 'Cancel', value: false }, { label: 'Save', value: true, primary: true }]);
    if (!ok) return;
    r.tags = tags.value.split(/\s+/).map((x) => x.replace(/^#/, '')).filter(Boolean);
    r.note = note.value;
    await app.saveHistory(r);
    render();
  }

  async function promote(r) {
    const name = h('input', { type: 'text', value: r.note || r.summary.slice(0, 70) });
    const rc = CL.toRecipe(r, '');
    const vars = rc.vars.length ? h('ul', rc.vars.map((v) => h('li', h('code', { text: `{{${v.name}}}` }), ` ${v.type} in command ${v.layer} (${v.mode === 'all' ? 'all of that type, ' + (v.strategy || 'multi') : 'one value'})`)))
      : h('p.muted', { text: 'This line uses no IOC set, so the recipe has no variables yet. It will replay exactly as saved.' });
    const ok = await ui.modal('Save as recipe', h('div', h('div.field', h('label', { text: 'Name' }), name), h('p', { text: 'Variables (bound to the active IOC set when you run the recipe):' }), vars), [{ label: 'Cancel', value: false }, { label: 'Save recipe', value: true, primary: true }]);
    if (!ok) return;
    rc.name = name.value || 'Recipe';
    await app.saveRecipe(rc);
    tab = 'recipes';
    render();
    ui.toast('Recipe saved');
  }

  // ---------------------------------------------------------------- recipes
  function renderRecipes() {
    const box = ui.clear(ui.$('#tab-recipes'));
    const pred = parseFilter(ui.$('#drawerSearch').value);
    const list = app.recipes.filter(pred);
    box.append(h('div.toolbar', h('span.muted.small', { text: 'A recipe is a saved chain whose IOC fields are variables. Run it to rebuild the chain against the active IOC set.' })));
    if (!list.length) { box.append(h('p.empty', { text: app.recipes.length ? 'Nothing matches the filter.' : 'Turn any history line into a recipe with ⇢R.' })); return; }
    const ul = h('ul.hist');
    for (const rc of list) {
      ul.append(h('li',
        h('span.when', { text: rc.vars.map((v) => `{{${v.name}}}`).join(' ') || 'fixed' }),
        h('div', h('div.cmd', { text: rc.name, onclick: () => runRecipe(rc) }), h('div.sub', { text: rc.text })),
        h('div.acts',
          h('button.btn', { text: 'Run with active set', onclick: () => runRecipe(rc) }),
          h('button.icon-btn', { text: '✎', title: 'Rename', onclick: async () => {
            const i = h('input', { type: 'text', value: rc.name });
            if (await ui.modal('Rename recipe', i, [{ label: 'Cancel', value: false }, { label: 'Save', value: true, primary: true }])) { rc.name = i.value; await app.saveRecipe(rc); render(); }
          } }),
          h('button.icon-btn', { text: '✕', title: 'Delete', onclick: async () => { await app.deleteRecipe(rc.id); render(); } }))));
    }
    box.append(ul);
  }

  function runRecipe(rc) {
    const set = app.activeSet();
    const bound = CL.bindRecipe(rc, set);
    const missing = rc.vars.filter((v) => bound.vars[v.name] === undefined);
    app.loadState(bound.state);
    if (missing.length) ui.toast(`No ${missing.map((v) => v.type.replace('ioc:', '')).join(', ')} in the active set: fill ${missing.map((v) => '{{' + v.name + '}}').join(', ')} by hand.`, 5000);
    else ui.toast(`Recipe "${rc.name}" built against ${set ? '"' + set.name + '"' : 'its saved values'}`);
  }

  // ---------------------------------------------------------------- IOC sets
  function renderIocs() {
    const box = ui.clear(ui.$('#tab-iocs'));
    const sets = [...app.sets.values()];
    if (!selSet || !app.sets.has(selSet)) selSet = app.activeSetId || (sets[0] && sets[0].id) || null;
    box.append(h('div.toolbar',
      h('button.btn.primary', { text: 'Paste report → extract IOCs', onclick: () => pasteIocs() }),
      h('button.btn', { text: 'New empty set', onclick: async () => { const s = CL.newIocSet('Set ' + (sets.length + 1)); await app.saveSet(s); selSet = s.id; if (!app.activeSetId) app.setActive(s.id); render(); } }),
      h('button.btn', { text: 'Import JSON / CSV', onclick: () => importSets() }),
      sets.length ? h('button.btn.danger', { text: 'Clear all sets', onclick: async () => {
        if (await ui.modal('Delete every IOC set?', h('p', { text: 'History keeps the values each line used. Recipes keep working with any set.' }), [{ label: 'Cancel', value: false }, { label: 'Delete all', value: true, danger: true }])) {
          for (const s of sets) await app.deleteSet(s.id);
          render();
        }
      } }) : null));
    if (!sets.length) { box.append(h('p.empty', { text: 'No IOC sets yet. Paste a report, e-mail or CSV and the IOCs are typed and re-fanged for you to review.' })); return; }
    const left = h('ul.setlist');
    for (const s of sets) {
      left.append(h('li' + (s.id === selSet ? '.sel' : ''), { onclick: () => { selSet = s.id; render(); } },
        h('span', { text: `${s.name} (${(s.items || []).length})` }), s.id === app.activeSetId ? h('span.act', { text: 'active' }) : null));
    }
    const s = app.sets.get(selSet);
    const right = h('div');
    if (s) {
      const save = () => app.saveSet(s);
      right.append(
        h('div.toolbar',
          h('input', { type: 'text', value: s.name, 'aria-label': 'Set name', oninput: (e) => { s.name = e.target.value; save(); app.renderSetPicker(); } }),
          s.id === app.activeSetId ? h('span.pill', { text: 'active' }) : h('button.btn', { text: 'Make active', onclick: () => { app.setActive(s.id); render(); } }),
          h('button.btn', { text: 'Add from paste', onclick: () => pasteIocs(s.id) }),
          h('button.btn', { text: 'Export JSON', onclick: () => ui.download(`iocs-${slug(s.name)}.json`, JSON.stringify(s, null, 2)) }),
          h('button.btn', { text: 'Export CSV', onclick: () => ui.download(`iocs-${slug(s.name)}.csv`, CL.iocSetToCsv(s), 'text/csv') }),
          h('button.btn.danger', { text: 'Clear set', onclick: async () => { s.items = []; await save(); app.changed('value'); render(); } }),
          h('button.btn.danger', { text: 'Delete set', onclick: async () => { await app.deleteSet(s.id); selSet = null; render(); } })),
        h('textarea', { rows: 2, placeholder: 'Note: case number, source report, scope…', value: s.note || '', oninput: (e) => { s.note = e.target.value; save(); } }));
      const counts = {};
      for (const i of s.items || []) counts[i.type] = (counts[i.type] || 0) + 1;
      right.append(h('p.muted.small', { text: Object.entries(counts).map(([t, n]) => `${n} ${t}`).join(', ') || 'Empty set.' }));
      const tb = h('table.ioctab', h('thead', h('tr', h('th', { text: 'Type' }), h('th', { text: 'Value' }), h('th', { text: '' }))));
      const body = h('tbody');
      (s.items || []).forEach((it, idx) => body.append(h('tr', h('td', { text: it.type }), h('td.v', { text: it.value }), h('td', h('button.icon-btn', { text: '✕', title: 'Remove', onclick: async () => { s.items.splice(idx, 1); await save(); app.changed('value'); render(); } })))));
      const typeSel = h('select', { 'aria-label': 'Type' }, CL.IOC_TYPES.map((t) => h('option', { value: t.id, text: t.label })));
      const val = h('input', { type: 'text', placeholder: 'Add one value', spellcheck: false });
      const add = async () => { if (!val.value.trim()) return; CL.addToSet(s, [{ type: typeSel.value, value: CL.refang(val.value.trim()), src: 'manual' }]); await save(); app.changed('value'); render(); };
      val.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
      body.append(h('tr', h('td', typeSel), h('td', val), h('td', h('button.btn', { text: 'Add', onclick: add }))));
      tb.append(body);
      right.append(tb);
    }
    box.append(h('div.cols', left, right));
  }

  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'set';

  async function pasteIocs(targetId) {
    const ta = h('textarea', { placeholder: 'Paste a report, e-mail, CSV or a list. Defanged values (hxxp, [.]) are re-fanged.', spellcheck: false });
    const text = await ui.modal('Extract IOCs', ta, [{ label: 'Cancel', value: null }, { label: 'Extract', value: () => ta.value, primary: true }]);
    if (!text) return;
    const found = CL.extractIocs(text);
    if (!found.length) { ui.toast('No IOCs found in that text.'); return; }
    const rows = found.map((f) => ({ keep: true, type: f.type, value: f.value, fromUrl: f.fromUrl, refanged: f.refanged }));
    const tbody = h('tbody');
    for (const r of rows) {
      const ts = h('select', { onchange: (e) => { r.type = e.target.value; } }, CL.IOC_TYPES.map((t) => h('option', { value: t.id, text: t.label })));
      ts.value = r.type;
      tbody.append(h('tr',
        h('td', h('input', { type: 'checkbox', checked: true, onchange: (e) => { r.keep = e.target.checked; } })),
        h('td', ts),
        h('td', h('input', { type: 'text', value: r.value, spellcheck: false, oninput: (e) => { r.value = e.target.value; } })),
        h('td.muted.small', { text: r.fromUrl ? 'host of a URL' : '' })));
    }
    const sets = [...app.sets.values()];
    const dest = h('select', { 'aria-label': 'Save into' }, h('option', { value: '__new', text: 'a new set…' }), sets.map((s) => h('option', { value: s.id, text: s.name })));
    dest.value = targetId || app.activeSetId || '__new';
    const newName = h('input', { type: 'text', placeholder: 'New set name', value: 'Case ' + new Date().toISOString().slice(0, 10) });
    const body = h('div',
      h('p.muted.small', { text: `${found.length} candidate${found.length > 1 ? 's' : ''}${found[0].refanged ? ', re-fanged' : ''}. Untick anything that is not an IOC, and fix the type where needed (an .exe is offered as a process).` }),
      h('table.ioctab', h('thead', h('tr', h('th', { text: '' }), h('th', { text: 'Type' }), h('th', { text: 'Value' }), h('th', { text: '' }))), tbody),
      h('div.toolbar', h('span', { text: 'Save into' }), dest, newName));
    const ok = await ui.modal('Review extracted IOCs', body, [{ label: 'Cancel', value: false }, { label: 'Save to set', value: true, primary: true }]);
    if (!ok) return;
    let set = dest.value === '__new' ? CL.newIocSet(newName.value || 'New set') : app.sets.get(dest.value);
    const n = CL.addToSet(set, rows.filter((r) => r.keep && r.value.trim()).map((r) => ({ type: r.type, value: r.value.trim() })));
    await app.saveSet(set);
    if (!app.activeSetId || dest.value === '__new') app.setActive(set.id);
    selSet = set.id;
    tab = 'iocs';
    render();
    ui.toast(`${n} IOC${n === 1 ? '' : 's'} saved to "${set.name}"`);
  }

  async function importSets() {
    const files = await ui.pickFiles('.json,.csv,.txt', true);
    let added = 0;
    for (const f of files) {
      const text = await ui.readFile(f);
      try {
        if (/\.json$/i.test(f.name)) {
          const j = JSON.parse(text);
          const list = Array.isArray(j) ? j : j.iocSets ? j.iocSets : [j];
          for (const s of list) {
            if (!s || !Array.isArray(s.items)) throw new Error('not an IOC set');
            const set = Object.assign(CL.newIocSet(s.name), { note: s.note || '' });
            CL.addToSet(set, s.items.filter((i) => i && i.type && i.value !== undefined));
            await app.saveSet(set);
            added++;
          }
        } else {
          const set = CL.newIocSet(f.name.replace(/\.[^.]+$/, ''));
          const rows = CL.iocCsvParse(text);
          CL.addToSet(set, rows.length ? rows : CL.extractIocs(text));
          await app.saveSet(set);
          added++;
        }
      } catch (e) { ui.toast(`${f.name}: ${e.message}`, 4000); }
    }
    if (added) { ui.toast(`Imported ${added} set${added > 1 ? 's' : ''}`); render(); }
  }

  // ---------------------------------------------------------------- paths
  function renderPaths() {
    const box = ui.clear(ui.$('#tab-paths'));
    const q = ui.$('#drawerSearch').value.toLowerCase();
    const os = app.shell().os === 'windows' ? 'windows' : 'linux';
    const all = app.cat.paths.filter((p) => p.os === os && (!q || (p.label + ' ' + p.value + ' ' + (p.tags || []).join(' ')).toLowerCase().includes(q)));
    box.append(h('div.toolbar', h('span.muted.small', { text: `${all.length} ${os} paths. These fill the Paths ▾ / Keys ▾ menus on path fields. Your additions are kept in this browser and in workspace exports.` }),
      h('button.btn', { text: 'Add a path', onclick: () => addPath(os) })));
    const tb = h('table.ioctab', h('thead', h('tr', h('th', { text: 'Label' }), h('th', { text: 'Path' }), h('th', { text: 'Tags' }), h('th', { text: '' }))));
    const body = h('tbody');
    for (const p of all) {
      const mine = app.userPaths.some((u) => u.id === p.id);
      body.append(h('tr', h('td', { text: p.label }), h('td.v', { text: p.value }), h('td.muted', { text: (p.tags || []).join(', ') + (p.expand ? ' (expands)' : '') }),
        h('td', h('button.icon-btn', { text: '⎘', title: 'Copy', onclick: async () => { await ui.copyText(p.value); ui.toast('Copied'); } }),
          mine ? h('button.icon-btn', { text: '✕', title: 'Remove', onclick: async () => { await app.deleteUserPath(p.id); render(); } }) : null)));
    }
    tb.append(body);
    box.append(tb);
  }

  async function addPath(os) {
    const label = h('input', { type: 'text', placeholder: 'Label' });
    const value = h('input', { type: 'text', placeholder: os === 'windows' ? 'C:\\Path or %APPDATA%\\x or HKLM\\Key' : '/path or /home/*/x' });
    const kind = h('select', h('option', { value: 'file', text: 'file' }), h('option', { value: 'dir', text: 'folder' }), h('option', { value: 'registry', text: 'registry key' }));
    const expand = h('input', { type: 'checkbox' });
    const tags = h('input', { type: 'text', placeholder: 'tags, comma-separated' });
    const ok = await ui.modal('Add a path', h('div.fgrid',
      h('div.field', h('label', { text: 'Label' }), label), h('div.field', h('label', { text: 'Path' }), value), h('div.field', h('label', { text: 'Kind' }), kind),
      h('div.field', h('label', { text: 'Tags' }), tags), h('div.field.bool', expand, h('label', { text: 'Contains * ~ %VAR% meant to expand' }))), [{ label: 'Cancel', value: false }, { label: 'Add', value: true, primary: true }]);
    if (!ok || !value.value.trim()) return;
    await app.saveUserPath({ id: CL.uid('up'), os, kind: kind.value, label: label.value || value.value, value: value.value.trim(), expand: expand.checked, tags: tags.value.split(',').map((x) => x.trim()).filter(Boolean) });
    render();
  }

  // ---------------------------------------------------------------- data
  function renderData() {
    const box = ui.clear(ui.$('#tab-data'));
    const attack = CL.DATA.attack;
    box.append(h('div.datagrid',
      h('section', h('h4', { text: 'Workspace file' }),
        h('p', { text: 'History, recipes, IOC sets, your paths, your tool files and settings in one JSON file. Import merges by id; older files are migrated.' }),
        h('div.toolbar', h('button.btn.primary', { text: 'Export workspace', onclick: exportWorkspace }), h('button.btn', { text: 'Import workspace', onclick: importWorkspace }))),
      h('section', h('h4', { text: 'Tool and shell files' }),
        h('p', { text: `${app.cat.tools.size} tools, ${app.cat.shells.size} shells loaded. Import a JSON tool or shell file to use it here; it is validated first and overrides a built-in file with the same id.` }),
        h('div.toolbar', h('button.btn', { text: 'Import tool / shell JSON', onclick: importToolFiles })),
        app.userTools.length || app.userShells.length ? h('ul', [...app.userTools, ...app.userShells].map((t) => h('li', h('code', { text: t.id }), ' ', h('button.icon-btn', { text: '✕', title: 'Remove', onclick: async () => { await app.deleteUserTool(t.id, !!t.quoting); render(); } })))) : null),
      h('section', h('h4', { text: 'Local data' }),
        h('p', { text: app.storageMode === 'indexeddb' ? 'Everything is stored only in this browser profile (IndexedDB). Nothing is ever sent anywhere: the page blocks all network connections.' : 'Storage is blocked in this browser, so nothing is being saved. Export your workspace before closing the tab.' }),
        h('div.toolbar', h('button.btn.danger', { text: 'Clear all local data', onclick: clearAll }))),
      h('section', h('h4', { text: 'About' }),
        h('p', { text: `Command Lens ${CL.VERSION}. Apache-2.0, © 2026 pearmanref.` }),
        h('p', { text: `MITRE ATT&CK Enterprise v${attack.version}: ${attack.techniques.length} techniques. ${attack.attribution}` }))));
  }

  async function exportWorkspace() {
    const ws = await app.workspace();
    ui.download(`command-lens-workspace-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(ws, null, 2));
    ui.toast('Workspace exported. It contains your IOCs: store it like case data.', 4000);
  }

  async function importWorkspace() {
    const [f] = await ui.pickFiles('.json');
    if (!f) return;
    try {
      const ws = CL.migrateWorkspace(JSON.parse(await ui.readFile(f)));
      const n = await app.importWorkspace(ws);
      ui.toast(`Imported ${n.history} history, ${n.recipes} recipes, ${n.sets} IOC sets`);
      render();
    } catch (e) { ui.toast('Import failed: ' + e.message, 5000); }
  }

  async function importToolFiles() {
    const files = await ui.pickFiles('.json', true);
    const msgs = [];
    for (const f of files) {
      try {
        const j = JSON.parse(await ui.readFile(f));
        const r = await app.importDataFile(j);
        msgs.push(`${f.name}: ${r}`);
      } catch (e) { msgs.push(`${f.name}: ${e.message}`); }
    }
    if (msgs.length) await ui.modal('Import results', h('ul', msgs.map((m) => h('li', { text: m }))));
    render();
  }

  async function clearAll() {
    const i = h('input', { type: 'text', placeholder: 'type CLEAR' });
    const ok = await ui.modal('Clear all local data?', h('div', h('p', { text: 'Deletes history, recipes, IOC sets, your paths and tool files, and settings from this browser. This cannot be undone. Export the workspace first if you need it.' }), i),
      [{ label: 'Cancel', value: false }, { label: 'Delete everything', value: () => i.value.trim() === 'CLEAR', danger: true }]);
    if (!ok) { if (i.value) ui.toast('Nothing deleted: type CLEAR to confirm.'); return; }
    await app.clearAll();
    render();
    ui.toast('All local data cleared');
  }

  // ---------------------------------------------------------------- tabs
  function render() {
    for (const b of document.querySelectorAll('.tabs [data-tab]')) b.setAttribute('aria-selected', b.dataset.tab === tab ? 'true' : 'false');
    for (const t of ['history', 'recipes', 'iocs', 'paths', 'data']) ui.$('#tab-' + t).hidden = t !== tab;
    ({ history: renderHistory, recipes: renderRecipes, iocs: renderIocs, paths: renderPaths, data: renderData })[tab]();
  }

  ui.drawer = {
    init(a) {
      app = a;
      for (const b of document.querySelectorAll('.tabs [data-tab]')) b.addEventListener('click', () => { tab = b.dataset.tab; render(); });
      ui.$('#drawerSearch').addEventListener('input', () => render());
      render();
    },
    render,
    show(t) { tab = t; render(); ui.$('#drawer').scrollIntoView({ behavior: 'smooth', block: 'start' }); },
    pasteIocs,
    exportWorkspace,
    runRecipe,
    focusSearch() { ui.$('#drawerSearch').focus(); },
  };
})(typeof window !== 'undefined' ? window : globalThis);
