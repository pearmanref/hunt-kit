/* L4 — command palette (Ctrl+K). One search box over tools, presets, ATT&CK techniques,
 * recipes, history and app actions, ranked by the catalog. Enter adds a new command after the
 * focused one; Shift+Enter replaces the focused command. */
(function (root) {
  'use strict';
  const CL = (root.CL = root.CL || {});
  const ui = (CL.ui = CL.ui || {});
  const h = (...a) => ui.h(...a);

  let app = null;
  let results = [];
  let sel = 0;

  function actions() {
    const list = [
      { label: 'New line (clear the builder)', run: () => app.newLine() },
      { label: 'Paste a report to extract IOCs', run: () => app.drawer.pasteIocs() },
      { label: 'Export workspace (history, recipes, IOC sets)', run: () => app.drawer.exportWorkspace() },
      { label: 'Toggle long flag names (--ignore-case vs -i)', run: () => { app.prefs.longFlags = !app.prefs.longFlags; app.saveSettings(); app.changed('structure'); } },
      { label: 'Toggle dark / light', run: () => app.toggleTheme() },
    ];
    for (const s of app.cat.shells.values()) list.push({ label: `Switch shell to ${s.name}`, run: () => app.setShell(s.id) });
    return list;
  }

  function search(q) {
    const st = app.state.shell;
    const out = [];
    for (const r of app.cat.search(q, st.id, st.version, 30)) {
      if (r.kind === 'tool') {
        const t = app.cat.tool(r.tool);
        out.push({ kind: 'tool', label: t.name, sub: r.note || t.summary, score: r.score, tool: r.tool });
      } else if (r.kind === 'preset') {
        const t = app.cat.tool(r.tool);
        const p = t.presets.find((x) => x.id === r.preset);
        out.push({ kind: 'preset', label: `${t.name}: ${p.name}`, sub: (p.ttps || []).map((id) => app.cat.techniqueLabel(id)).join('; '), score: r.score, tool: r.tool, preset: r.preset });
      } else {
        out.push({ kind: 'technique', label: r.label, sub: r.hunters ? `${r.hunters} tool/preset${r.hunters > 1 ? 's' : ''} in ${app.shell().name} hunt this. Enter to list them.` : `Nothing in ${app.shell().name} maps to this yet.`, score: r.score, tech: r.tech });
      }
    }
    const ql = q.trim().toLowerCase();
    if (ql) {
      for (const rc of app.recipes) if ((rc.name + ' ' + rc.text).toLowerCase().includes(ql)) out.push({ kind: 'recipe', label: rc.name, sub: rc.text, score: 8, recipe: rc });
      let n = 0;
      for (const hi of app.history) {
        if (n >= 5) break;
        if ((hi.text + ' ' + hi.summary + ' ' + (hi.tags || []).join(' ')).toLowerCase().includes(ql)) { out.push({ kind: 'history', label: hi.text, sub: hi.summary, score: 3, hist: hi }); n++; }
      }
      for (const a of actions()) if (a.label.toLowerCase().includes(ql)) out.push({ kind: 'action', label: a.label, score: 2, run: a.run });
    } else {
      for (const a of actions().slice(0, 3)) out.push({ kind: 'action', label: a.label, score: 0, run: a.run });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 40);
  }

  function render() {
    const list = ui.clear(ui.$('#paletteList'));
    results.forEach((r, i) => {
      const li = h('li', { role: 'option', 'aria-selected': i === sel ? 'true' : 'false', onmousemove: () => { if (sel !== i) { sel = i; mark(); } }, onclick: (e) => choose(e.shiftKey) },
        h('span.kind', { text: r.kind }), h('span.lbl', { text: r.label }), r.sub ? h('span.sub', { text: r.sub }) : null);
      list.append(li);
    });
    if (!results.length) list.append(h('li', h('span.kind', { text: '' }), h('span.muted', { text: 'Nothing matches in this shell. Try another word, a technique ID, or switch shells.' })));
  }
  function mark() {
    [...ui.$('#paletteList').children].forEach((li, i) => li.setAttribute('aria-selected', i === sel ? 'true' : 'false'));
    const cur = ui.$('#paletteList').children[sel];
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }

  function choose(replace) {
    const r = results[sel];
    if (!r) return;
    if (r.kind === 'technique') { const i = ui.$('#paletteInput'); i.value = r.tech; update(); return; }
    const join = app.pendingJoin; // close() forgets it, so read it first
    close();
    if (r.kind === 'tool') app.addLayer(r.tool, null, { replace, join });
    else if (r.kind === 'preset') app.addLayer(r.tool, r.preset, { replace, join });
    else if (r.kind === 'recipe') app.drawer.runRecipe(r.recipe);
    else if (r.kind === 'history') app.loadState(r.hist.state);
    else if (r.kind === 'action') r.run();
  }

  function update() {
    results = search(ui.$('#paletteInput').value);
    sel = 0;
    render();
  }

  function close() {
    ui.$('#palette').hidden = true;
    app.pendingJoin = null;
    if (app.lastFocus && document.body.contains(app.lastFocus)) app.lastFocus.focus();
  }

  ui.palette = {
    init(a) {
      app = a;
      const input = ui.$('#paletteInput');
      input.addEventListener('input', update);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(results.length - 1, sel + 1); mark(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); mark(); }
        else if (e.key === 'Enter') { e.preventDefault(); choose(e.shiftKey); }
        else if (e.key === 'Escape') { e.preventDefault(); close(); }
      });
      ui.$('#palette').addEventListener('mousedown', (e) => { if (e.target.id === 'palette') close(); });
    },
    open(q) {
      app.lastFocus = document.activeElement;
      ui.$('#palette').hidden = false;
      const input = ui.$('#paletteInput');
      input.value = q || '';
      // say where the new command goes and with which operator
      const ctx = ui.$('#paletteCtx');
      const items = app.state.root.items;
      if (items.length) {
        const i = Math.max(0, items.findIndex((l) => l.id === app.focusId));
        const at = items.findIndex((l) => l.id === app.focusId) >= 0 ? i : items.length - 1;
        const op = (app.shell().operators || []).find((o) => o.id === (app.pendingJoin || 'pipe'));
        const t = app.cat.tool(items[at].tool);
        ctx.textContent = `Adds after command ${at + 1} (${t ? t.name : items[at].tool}), joined with ${op ? op.symbol + '  ' + op.desc : '|'}`;
        ctx.hidden = false;
      } else ctx.hidden = true;
      update();
      input.focus();
      input.select();
    },
    close,
  };
})(typeof window !== 'undefined' ? window : globalThis);
