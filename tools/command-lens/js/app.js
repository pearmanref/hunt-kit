/* L4 — application wiring: state ownership, persistence calls, keyboard, and the render loop.
 * The one rule: views change BuildState and call changed(); the line is always re-derived. */
(function (root) {
  'use strict';
  const CL = (root.CL = root.CL || {});
  const ui = CL.ui;
  const h = (...a) => ui.h(...a);
  const store = CL.store;

  const app = {
    cat: null,
    state: null,
    result: null,
    sets: new Map(),
    activeSetId: null,
    history: [],
    recipes: [],
    userPaths: [],
    userTools: [],
    userShells: [],
    prefs: { longFlags: false },
    recent: {},
    drafts: {},
    focusId: null,
    ack: false,
    storageMode: 'memory',
    ui: { advOpen: {} },
    drawer: null,
  };

  // ---------------------------------------------------------------- catalog / state
  app.buildCatalog = function () {
    app.cat = new CL.Catalog(CL.DATA, {
      tools: Object.fromEntries(app.userTools.map((t) => [t.id, t])),
      shells: Object.fromEntries(app.userShells.map((s) => [s.id, s])),
      paths: app.userPaths,
    });
  };
  app.shell = () => app.cat.shell(app.state.shell.id);
  app.activeSet = () => (app.activeSetId ? app.sets.get(app.activeSetId) : null) || null;
  app.ctx = () => ({ iocSets: Object.fromEntries(app.sets), prefs: app.prefs });

  app.assemble = function () {
    try {
      app.result = CL.assemble(app.state, app.cat, app.ctx());
    } catch (e) {
      console.error(e);
      app.result = { tokens: [], text: '', diags: [CL.diag('error', 'internal', 'Internal error: ' + e.message)], errors: 1, warnings: 0, summary: '', ttps: [], requires: [], opsec: [], layers: [], ops: [], layerText: {}, shell: app.shell(), version: app.state.shell.version };
    }
    return app.result;
  };

  app.changed = function (kind) {
    if (kind === 'structure') ui.renderLayers(app);
    const r = app.assemble();
    if (!r.errors) app.ack = false;
    ui.renderOutput(app, r);
    app.saveDraft();
  };
  app.renderLayers = () => ui.renderLayers(app);

  app.saveDraft = function () {
    app.drafts[app.state.shell.id] = app.state;
    store.setSetting('drafts', app.drafts);
    store.setSetting('shell', { id: app.state.shell.id, version: app.state.shell.version });
  };
  app.saveSettings = function () {
    store.setSetting('prefs', app.prefs);
    store.setSetting('recent', app.recent);
  };

  // ---------------------------------------------------------------- layers
  const items = () => app.state.root.items;
  const focusIdx = () => {
    const i = items().findIndex((l) => l.id === app.focusId);
    return i >= 0 ? i : items().length - 1;
  };
  app.focus = function (id) {
    if (app.focusId === id) return;
    app.focusId = id;
    for (const el of document.querySelectorAll('.layer')) el.classList.toggle('focus', el.dataset.id === id);
  };
  app.focusLayerEl = function (id) {
    app.focus(id);
    const el = document.querySelector(`.layer[data-id="${id}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  app.addLayer = function (toolId, presetId, opts) {
    opts = opts || {};
    const tool = app.cat.tool(toolId);
    const tShell = app.cat.toolShell(tool, app.state.shell.id, app.state.shell.version);
    if (!tShell || tShell._versionBlocked) { ui.toast(`${tool.name} does not run in ${app.shell().name}${tShell ? ' ' + app.state.shell.version : ''}.`); return; }
    const layer = CL.newLayer(app.state, app.cat, toolId, presetId);
    const idx = focusIdx();
    if (opts.replace && items().length) {
      layer.id = items()[idx].id;
      items()[idx] = layer;
    } else {
      // the operator comes from the add button the analyst chose (| && || ;), else a pipe
      CL.insertLayer(app.state, layer, items().length ? idx : undefined, opts.join || app.pendingJoin || 'pipe');
    }
    app.pendingJoin = null;
    app.focusId = layer.id;
    app.changed('structure');
    setTimeout(() => {
      const scope = `.layer[data-id="${layer.id}"] .layer-body`;
      const el = document.querySelector(`${scope} .fgrid input[type=text]:not(:disabled), ${scope} .fgrid textarea:not(:disabled)`) || document.querySelector(`${scope} .fgrid input, ${scope} .fgrid select`);
      if (el) el.focus();
    }, 0);
  };
  /** "Add after with &&" etc.: remember the operator, then pick the tool in the palette. */
  app.addWith = function (joinId) {
    app.pendingJoin = joinId;
    app.openPalette();
  };
  app.move = function (idx, d) { CL.moveLayer(app.state, idx, d); app.changed('structure'); };
  app.moveTo = function (from, to) {
    if (from === to || Number.isNaN(from)) return;
    const step = to > from ? 1 : -1;
    for (let i = from; i !== to; i += step) CL.moveLayer(app.state, i, step);
    app.changed('structure');
  };
  app.duplicate = function (idx) {
    const src = items()[idx];
    const copy = CL.clone(src);
    copy.id = CL.nextLayerId(app.state);
    CL.insertLayer(app.state, copy, idx, app.state.root.joins[idx - 1] || 'pipe');
    app.focusId = copy.id;
    app.changed('structure');
  };
  app.toggleDisabled = function (idx) { items()[idx].disabled = !items()[idx].disabled; app.changed('structure'); };
  app.remove = function (idx) { CL.removeLayer(app.state, idx); app.changed('structure'); };
  app.applyFix = function (fix) {
    if (fix.action !== 'insert') return;
    const idx = items().findIndex((l) => l.id === fix.before);
    if (idx < 0) return;
    const layer = CL.newLayer(app.state, app.cat, fix.tool);
    CL.insertLayer(app.state, layer, idx - 1, 'pipe');
    app.changed('structure');
    ui.toast(`Inserted ${app.cat.tool(fix.tool).name}`);
  };

  app.newLine = function () {
    app.state = CL.newState(app.state.shell.id, app.state.shell.version);
    app.focusId = null;
    app.changed('structure');
  };

  app.loadState = function (s) {
    const st = CL.migrateState(CL.clone(s));
    if (!app.cat.shell(st.shell.id)) { ui.toast(`Unknown shell ${st.shell.id}`); return; }
    app.state = st;
    app.focusId = items().length ? items()[items().length - 1].id : null;
    app.renderShellBar();
    app.changed('structure');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  app.setShell = function (id) {
    if (id === app.state.shell.id) return;
    app.saveDraft();
    const s = app.cat.shell(id);
    // each shell keeps its own draft: the tools of one shell do not run in another
    const d = app.drafts[id];
    app.state = d ? CL.migrateState(d) : CL.newState(id, s.versions ? store.getSetting('psver', s.versions[s.versions.length - 1]) : null);
    app.focusId = null;
    app.renderShellBar();
    app.changed('structure');
  };
  app.setVersion = function (v) {
    app.state.shell.version = v;
    store.setSetting('psver', v);
    app.renderShellBar();
    app.changed('structure');
  };

  app.renderShellBar = function () {
    const bar = ui.clear(ui.$('#shellbar'));
    let i = 1;
    for (const s of app.cat.shells.values()) {
      const n = i++;
      bar.append(h('button', { role: 'radio', 'aria-checked': s.id === app.state.shell.id ? 'true' : 'false', title: `${s.name} (Ctrl+${n})`, text: s.name, onclick: () => app.setShell(s.id) }));
    }
    const vb = ui.clear(ui.$('#psver'));
    const sh = app.shell();
    vb.hidden = !sh.versions;
    for (const v of sh.versions || []) vb.append(h('button', { role: 'radio', 'aria-checked': v === app.state.shell.version ? 'true' : 'false', text: v, title: `${sh.name} ${v}`, onclick: () => app.setVersion(v) }));
  };

  // ---------------------------------------------------------------- IOC sets
  app.renderSetPicker = function () {
    const sel = ui.clear(ui.$('#activeSet'));
    sel.append(h('option', { value: '', text: app.sets.size ? '— none —' : 'none yet' }));
    for (const s of app.sets.values()) sel.append(h('option', { value: s.id, text: `${s.name} (${(s.items || []).length})` }));
    sel.value = app.activeSetId || '';
  };
  app.setActive = function (id) {
    app.activeSetId = id || null;
    store.setSetting('activeSet', app.activeSetId);
    app.renderSetPicker();
    app.changed('value');
  };
  app.saveSet = async function (s) { app.sets.set(s.id, s); await store.put('iocSets', s); app.renderSetPicker(); };
  app.deleteSet = async function (id) {
    app.sets.delete(id);
    await store.del('iocSets', id);
    if (app.activeSetId === id) app.activeSetId = null;
    store.setSetting('activeSet', app.activeSetId);
    app.renderSetPicker();
    app.changed('structure');
  };

  // ---------------------------------------------------------------- history / recipes / paths / tools
  app.saveHistory = async function (rec) {
    const i = app.history.findIndex((x) => x.id === rec.id);
    if (i >= 0) app.history[i] = rec; else app.history.push(rec);
    await store.put('history', rec);
  };
  app.deleteHistory = async function (id) { app.history = app.history.filter((x) => x.id !== id); await store.del('history', id); };
  app.saveRecipe = async function (rc) {
    const i = app.recipes.findIndex((x) => x.id === rc.id);
    if (i >= 0) app.recipes[i] = rc; else app.recipes.push(rc);
    await store.put('recipes', rc);
  };
  app.deleteRecipe = async function (id) { app.recipes = app.recipes.filter((x) => x.id !== id); await store.del('recipes', id); };
  app.saveUserPath = async function (p) { app.userPaths.push(p); await store.put('userPaths', p); app.buildCatalog(); };
  app.deleteUserPath = async function (id) { app.userPaths = app.userPaths.filter((x) => x.id !== id); await store.del('userPaths', id); app.buildCatalog(); };
  app.deleteUserTool = async function (id, isShell) {
    if (isShell) { app.userShells = app.userShells.filter((x) => x.id !== id); await store.del('userShells', id); }
    else { app.userTools = app.userTools.filter((x) => x.id !== id); await store.del('userTools', id); }
    app.buildCatalog();
    app.renderShellBar();
    app.changed('structure');
  };

  /** Validate and store an imported tool or shell file (same checks as scripts/validate.js). */
  app.importDataFile = async function (j) {
    delete j.$schema;
    const isShell = !!j.quoting || (!!j.extends && !j.params);
    const schema = isShell ? CL.DATA.schemas.shell : CL.DATA.schemas.tool;
    const shape = CL.schemaValidate(schema, j);
    if (shape.length) throw new Error('not imported: ' + shape.slice(0, 4).join('; '));
    const shells = new Set([...app.cat.shells.keys()].concat(isShell ? [j.id] : []));
    if (isShell) {
      const r = CL.validateShell(j, { shells });
      if (r.errors.length) throw new Error('not imported: ' + r.errors.join('; '));
      app.userShells = app.userShells.filter((x) => x.id !== j.id).concat(j);
      await store.put('userShells', j);
    } else {
      const trial = new CL.Catalog(CL.DATA, { tools: Object.fromEntries(app.userTools.concat(j).map((t) => [t.id, t])), shells: Object.fromEntries(app.userShells.map((s) => [s.id, s])) });
      const r = CL.validateTool(j, { shells, attack: CL.DATA.attack, cat: trial });
      if (r.errors.length) throw new Error('not imported: ' + r.errors.slice(0, 5).join('; '));
      app.userTools = app.userTools.filter((x) => x.id !== j.id).concat(j);
      await store.put('userTools', j);
    }
    app.buildCatalog();
    app.renderShellBar();
    app.changed('structure');
    return `${isShell ? 'shell' : 'tool'} "${j.id}" imported${CL.DATA[isShell ? 'shells' : 'tools'][j.id] ? ' (overrides the built-in file)' : ''}`;
  };

  app.workspace = async function () {
    return Object.assign(CL.newWorkspace(), {
      exported: CL.isoNow(),
      settings: { prefs: app.prefs, activeSet: app.activeSetId, shell: app.state.shell },
      history: app.history,
      recipes: app.recipes,
      iocSets: [...app.sets.values()],
      userPaths: app.userPaths,
      userTools: app.userTools,
      userShells: app.userShells,
    });
  };
  app.importWorkspace = async function (ws) {
    const n = { history: 0, recipes: 0, sets: 0 };
    for (const r of ws.history || []) { await app.saveHistory(r); n.history++; }
    for (const r of ws.recipes || []) { await app.saveRecipe(r); n.recipes++; }
    for (const s of ws.iocSets || []) { await app.saveSet(s); n.sets++; }
    for (const p of ws.userPaths || []) if (!app.userPaths.some((x) => x.id === p.id)) { app.userPaths.push(p); await store.put('userPaths', p); }
    for (const t of ws.userTools || []) { try { await app.importDataFile(t); } catch (e) { ui.toast(`Tool ${t.id}: ${e.message}`, 5000); } }
    for (const t of ws.userShells || []) { try { await app.importDataFile(t); } catch (e) { ui.toast(`Shell ${t.id}: ${e.message}`, 5000); } }
    if (!app.activeSetId && ws.settings && ws.settings.activeSet && app.sets.has(ws.settings.activeSet)) app.setActive(ws.settings.activeSet);
    app.buildCatalog();
    app.changed('structure');
    return n;
  };
  app.clearAll = async function () {
    await store.clearAll();
    Object.assign(app, { sets: new Map(), activeSetId: null, history: [], recipes: [], userPaths: [], userTools: [], userShells: [], recent: {}, drafts: {} });
    app.buildCatalog();
    app.state = CL.newState(app.state.shell.id, app.state.shell.version);
    app.renderSetPicker();
    app.renderShellBar();
    app.changed('structure');
  };

  // ---------------------------------------------------------------- recent values
  const recentKey = (p) => (p.ioc ? 'ioc:' + [].concat(p.ioc).join(',') : p.type === 'path' ? 'path:' + (p.pathKind || 'file') : null);
  app.recentFor = (p) => (recentKey(p) && app.recent[recentKey(p)]) || [];
  function rememberValues() {
    for (const l of CL.allLayers(app.state)) {
      const t = app.cat.tool(l.tool);
      if (!t) continue;
      for (const p of t.params || []) {
        const k = recentKey(p);
        const v = l.values[p.id];
        if (!k || v === undefined || typeof v === 'object') continue;
        const list = (app.recent[k] || []).filter((x) => x !== String(v));
        list.unshift(String(v));
        app.recent[k] = list.slice(0, 8);
      }
    }
    app.saveSettings();
  }

  // ---------------------------------------------------------------- copy / save
  app.copy = async function (format) {
    const r = app.result;
    if (!r || !r.tokens.length) { ui.toast('Nothing to copy yet'); return; }
    if (r.errors && !app.ack) { ui.toast('Fix the errors first (or tick "Copy anyway").'); return; }
    let text;
    try { text = CL.exportAs(format || ui.$('#copyFormat').value, r); } catch (e) { ui.toast(e.message, 4500); return; }
    const ok = await ui.copyText(text);
    await app.saveHistory(CL.historyRecord(app.state, r, app.ctx(), { source: 'copy' }));
    rememberValues();
    ui.drawer.render();
    ui.toast(ok ? 'Copied and saved to history' : 'Clipboard blocked: select the line and copy it by hand');
  };
  app.copyLayer = async function (id) {
    const t = app.result && app.result.layerText[id];
    if (!t) { ui.toast('That command is skipped or empty'); return; }
    await ui.copyText(t);
    ui.toast('Copied this command only');
  };
  app.save = async function () {
    const r = app.result;
    if (!r || !r.tokens.length) { ui.toast('Nothing to save yet'); return; }
    const tags = h('input', { type: 'text', placeholder: 'case-0314 persistence' });
    const note = h('input', { type: 'text', placeholder: 'What this line is for' });
    const ok = await ui.modal('Save to history', h('div.fgrid', h('div.field', h('label', { text: 'Tags (space-separated)' }), tags), h('div.field', h('label', { text: 'Note' }), note)),
      [{ label: 'Cancel', value: false }, { label: 'Save', value: true, primary: true }]);
    if (!ok) return;
    const rec = CL.historyRecord(app.state, r, app.ctx(), { tags: tags.value.split(/\s+/).filter(Boolean), note: note.value, source: 'save' });
    rec.pinned = true;
    await app.saveHistory(rec);
    rememberValues();
    ui.drawer.render();
    ui.toast('Saved and pinned');
  };

  app.openPalette = (q) => ui.palette.open(q);
  app.toggleTheme = function () {
    const cur = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = cur;
    store.setSetting('theme', cur);
  };

  async function showHelp() {
    const keys = [['Ctrl K', 'Find a tool, preset, ATT&CK technique, recipe or action'], ['Ctrl Enter', 'Copy the line (and save it to history)'], ['Ctrl S', 'Save with tags and pin'],
      ['Ctrl Shift N', 'Add a command after the current one'], ['Alt ↑ / Alt ↓', 'Move the current command'], ['Ctrl D', 'Duplicate the current command'], ['Ctrl /', 'Skip / restore the current command'],
      ['Ctrl Delete', 'Delete the current command'], ['Ctrl 1–4', 'Switch shell'], ['/', 'Filter history'], ['Hover a token', 'Highlight its explanation (click jumps to its field)']];
    await ui.modal('Keyboard', h('div.keys', keys.map(([k, d]) => [h('kbd', { text: k }), h('span', { text: d })])));
  }

  function keyboard(e) {
    const inField = /INPUT|TEXTAREA|SELECT/.test((e.target && e.target.tagName) || '');
    const mod = e.ctrlKey || e.metaKey;
    if (!ui.$('#modal').hidden || !ui.$('#palette').hidden) return;
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); app.openPalette(); return; }
    if (mod && e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) ui.$('#copyFormat').focus(); else app.copy(); return; }
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); app.save(); return; }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); app.openPalette(); return; }
    if (mod && /^[1-9]$/.test(e.key)) {
      const s = [...app.cat.shells.keys()][Number(e.key) - 1];
      if (s) { e.preventDefault(); app.setShell(s); }
      return;
    }
    const idx = items().findIndex((l) => l.id === app.focusId);
    if (idx >= 0) {
      if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); app.move(idx, -1); return; }
      if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); app.move(idx, 1); return; }
      if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); app.duplicate(idx); return; }
      if (mod && e.key === '/') { e.preventDefault(); app.toggleDisabled(idx); return; }
      if (mod && e.key === 'Delete') { e.preventDefault(); app.remove(idx); return; }
    }
    if (!inField && e.key === '/') { e.preventDefault(); ui.drawer.focusSearch(); return; }
    if (!inField && e.key === '?') { e.preventDefault(); showHelp(); }
  }

  // ---------------------------------------------------------------- boot
  app.init = async function () {
    document.documentElement.dataset.theme = store.getSetting('theme', 'dark');
    ui.$('#ver').textContent = 'v' + CL.VERSION;
    app.storageMode = await store.open();
    const [hist, rec, sets, paths, tools, shells] = await Promise.all(['history', 'recipes', 'iocSets', 'userPaths', 'userTools', 'userShells'].map((s) => store.all(s)));
    app.history = hist; app.recipes = rec; app.userPaths = paths; app.userTools = tools; app.userShells = shells;
    for (const s of sets) app.sets.set(s.id, s);
    app.prefs = Object.assign(app.prefs, store.getSetting('prefs', {}));
    app.recent = store.getSetting('recent', {});
    app.drafts = store.getSetting('drafts', {}) || {};
    app.activeSetId = store.getSetting('activeSet', null);
    if (app.activeSetId && !app.sets.has(app.activeSetId)) app.activeSetId = null;
    try { app.buildCatalog(); } catch (e) {
      // a broken imported file must never lock the analyst out
      app.userTools = []; app.userShells = [];
      app.buildCatalog();
      ui.toast('An imported tool/shell file failed to load and was skipped: ' + e.message, 6000);
    }
    const sh = store.getSetting('shell', { id: 'bash', version: null });
    const shellId = app.cat.shell(sh.id) ? sh.id : 'bash';
    const draft = app.drafts[shellId];
    try { app.state = draft ? CL.migrateState(draft) : null; } catch (e) { app.state = null; }
    if (!app.state) { const s = app.cat.shell(shellId); app.state = CL.newState(shellId, s.versions ? sh.version || s.versions[s.versions.length - 1] : null); }
    // drop layers whose tool vanished (e.g. a removed import)
    const g = app.state.root;
    for (let i = g.items.length - 1; i >= 0; i--) if (g.items[i].kind === 'layer' && !app.cat.tool(g.items[i].tool)) CL.removeLayer(app.state, i);

    const pill = ui.$('#storagePill');
    if (app.storageMode !== 'indexeddb' || !store.setSetting('probe', 1)) { pill.hidden = false; pill.classList.add('bad'); pill.textContent = 'Not saving: export your workspace before closing'; }

    const fmt = ui.$('#copyFormat');
    for (const e of CL.exporters) fmt.append(h('option', { value: e.id, text: e.label }));
    fmt.value = store.getSetting('copyFormat', 'line');
    fmt.addEventListener('change', () => store.setSetting('copyFormat', fmt.value));
    ui.$('#copyBtn').addEventListener('click', () => app.copy());
    ui.$('#saveBtn').addEventListener('click', () => app.save());
    ui.$('#clearBtn').addEventListener('click', () => app.newLine());
    ui.$('#openPalette').addEventListener('click', () => app.openPalette());
    ui.$('#themeBtn').addEventListener('click', app.toggleTheme);
    ui.$('#helpBtn').addEventListener('click', showHelp);
    ui.$('#activeSet').addEventListener('change', (e) => { app.setActive(e.target.value); ui.drawer.render(); });
    document.addEventListener('keydown', keyboard);

    app.drawer = ui.drawer;
    ui.palette.init(app);
    ui.drawer.init(app);
    ui.wireHighlight();
    app.renderShellBar();
    app.renderSetPicker();
    app.changed('structure');
    root.__app = app; // for the browser tests
  };

  CL.app = app;
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => app.init());
    else app.init();
  }
})(typeof window !== 'undefined' ? window : globalThis);
