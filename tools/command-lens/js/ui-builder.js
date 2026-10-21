/* L4 — the builder: layer cards with their operators, and the readout/explanation views.
 * renderLayers() runs on structural changes (add, move, preset); renderOutput() runs on every
 * keystroke and only touches the readout, diagnostics and inspector, so typing never loses focus. */
(function (root) {
  'use strict';
  const CL = (root.CL = root.CL || {});
  const ui = (CL.ui = CL.ui || {});
  const h = (...a) => ui.h(...a);

  function joiner(app, idx) {
    const g = app.state.root;
    const shell = app.shell();
    const ver = app.state.shell.version;
    const sel = h('select', { 'aria-label': `Operator before command ${idx + 1}`, onchange: (e) => { g.joins[idx - 1] = e.target.value; app.changed('structure'); } });
    for (const o of shell.operators || []) {
      const note = !CL.versionOk(o, ver) ? (o.fallback ? `  (${o.minVersion}+; ${ver} form used)` : `  (${o.minVersion}+ only)`) : '';
      sel.append(h('option', { value: o.id, text: `${o.symbol}  ${o.kind === 'pipe' ? 'pipe' : o.kind === 'pipe-all' ? 'pipe + errors' : o.kind === 'and' ? 'if it succeeded' : o.kind === 'or' ? 'if it failed' : 'then'}${note}` }));
    }
    sel.value = g.joins[idx - 1] || 'pipe';
    const op = (shell.operators || []).find((o) => o.id === sel.value);
    return h('div.joiner', sel, h('span.opdesc', { text: op ? op.desc : '' }));
  }

  ui.renderLayers = function (app) {
    const box = ui.clear(ui.$('#layers'));
    const items = app.state.root.items;
    items.forEach((layer, idx) => {
      if (idx > 0) box.append(joiner(app, idx));
      const tool = app.cat.tool(layer.tool);
      const card = h('article.layer', { 'data-id': layer.id, 'data-idx': idx, onfocusin: () => app.focus(layer.id), onmousedown: () => app.focus(layer.id) });
      if (layer.disabled) card.classList.add('disabled');
      if (layer.collapsed) card.classList.add('collapsed');
      if (app.focusId === layer.id) card.classList.add('focus');
      const grip = h('span.grip', { text: '⠿', title: 'Drag to reorder (or Alt+↑/↓)', draggable: 'true' });
      grip.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', String(idx)); e.dataTransfer.effectAllowed = 'move'; });
      card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('drag-over'); });
      card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
      card.addEventListener('drop', (e) => {
        e.preventDefault();
        card.classList.remove('drag-over');
        const from = Number(e.dataTransfer.getData('text/plain'));
        app.moveTo(from, idx);
      });
      const b = (text, title, fn) => h('button.icon-btn', { type: 'button', text, title, onclick: (e) => { e.stopPropagation(); fn(); } });
      const head = h('div.layer-head',
        grip,
        h('span.num', { text: String(idx + 1) }),
        h('span.tname', { text: tool ? tool.name : layer.tool, title: tool ? tool.summary : '' }),
        h('span.ltext', { 'data-ltext': layer.id, text: '' }),
        h('div.tools',
          b('⎘', 'Copy just this command', () => app.copyLayer(layer.id)),
          b('↑', 'Move up (Alt+↑)', () => app.move(idx, -1)),
          b('↓', 'Move down (Alt+↓)', () => app.move(idx, 1)),
          b('⧉', 'Duplicate (Ctrl+D)', () => app.duplicate(idx)),
          b(layer.disabled ? '◌' : '⊘', layer.disabled ? 'Enable (Ctrl+/)' : 'Skip this command for now (Ctrl+/)', () => app.toggleDisabled(idx)),
          b('✕', 'Delete (Ctrl+Delete)', () => app.remove(idx)),
          b(layer.collapsed ? '▸' : '▾', layer.collapsed ? 'Expand' : 'Collapse', () => { layer.collapsed = !layer.collapsed; app.changed('structure'); })));
      card.append(head, ui.layerForm(app, layer));
      box.append(card);
    });
    // add row: one button per operator of this shell, so | && || ; are visible before the second command exists
    const row = ui.clear(ui.$('#addRow'));
    if (!items.length) {
      row.append(h('button.btn', { text: '+ Add command', title: 'Pick a tool (Ctrl+K)', onclick: () => app.openPalette() }),
        h('span.muted.small', { text: 'Ctrl+K, then type a tool (grep, Get-WinEvent, netstat), a technique (T1053.005), a task (scheduled task), or { } / ? for a script-block condition.' }));
    } else {
      const ver = app.state.shell.version;
      const LABEL = { pipe: 'pipe into…', 'pipe-all': 'pipe output + errors into…', and: 'if it worked, run…', or: 'if it failed, run…', seq: 'then run…' };
      row.append(h('span.muted.small', { text: 'Add next:' }));
      for (const o of app.shell().operators || []) {
        const note = CL.versionOk(o, ver) ? '' : o.fallback ? ` (${ver}: written as ${o.fallback.replace('{left}', '…').replace('{right}', '…')})` : ` (${o.minVersion}+ only)`;
        row.append(h('button.btn.opbtn', { 'data-op': o.id, title: o.desc + note, onclick: () => app.addWith(o.id) },
          h('code', { text: o.symbol }), ' ' + (LABEL[o.kind] || o.id)));
      }
    }
  };

  /** Which tokens carry an IOC-set value (shown in teal). */
  function iocParams(app) {
    const s = new Set();
    for (const l of CL.allLayers(app.state)) for (const [pid, v] of Object.entries(l.values || {})) if (v && typeof v === 'object' && v.ioc) s.add(l.id + '|' + pid);
    return s;
  }

  ui.renderOutput = function (app, r) {
    const shell = app.shell();
    ui.$('#prompt').textContent = shell.prompt || '$';
    const line = ui.clear(ui.$('#line'));
    const iocs = iocParams(app);
    if (!r.tokens.length) {
      line.append(h('span.placeholder', { text: 'Pick a tool to start: Ctrl+K' }));
    } else {
      r.tokens.forEach((t, i) => {
        if (t.role === 'newline') { line.append('\n'); return; }
        const prev = r.tokens[i - 1];
        if (i > 0 && !t.glue && !(prev && prev.role === 'newline')) line.append(' ');
        const cls = ['t', t.role];
        if (t.param && iocs.has(t.layer + '|' + t.param)) cls.push('ioc');
        line.append(h('span.' + cls.join('.'), { 'data-i': i, 'data-layer': t.layer || '', 'data-param': t.param || '', text: t.text, title: t.explain || '' }));
      });
    }
    // diagnostics
    const sum = ui.clear(ui.$('#diagsum'));
    const infos = r.diags.filter((d) => d.level === 'info').length;
    if (r.errors) sum.append(h('span.e', { text: `✖ ${r.errors} must fix` }));
    if (r.warnings) sum.append(h('span.w', { text: `⚠ ${r.warnings} check` }));
    if (infos) sum.append(h('span.i', { text: `ℹ ${infos} note${infos > 1 ? 's' : ''}` }));
    if (!r.errors && r.tokens.length) sum.append(h('span.okk', { text: `Ready for ${shell.name}${r.version ? ' ' + r.version : ''}` }));
    const copy = ui.$('#copyBtn');
    copy.setAttribute('aria-disabled', r.errors && !app.ack ? 'true' : 'false');
    copy.textContent = r.errors && !app.ack ? 'Fix errors to copy' : 'Copy';
    const list = ui.clear(ui.$('#diags'));
    const order = { error: 0, warn: 1, info: 2 };
    for (const d of [...r.diags].sort((a, b) => order[a.level] - order[b.level])) {
      const where = d.ref && d.ref.layer ? (() => {
        const idx = app.state.root.items.findIndex((l) => l.id === d.ref.layer);
        const l = app.state.root.items[idx];
        const t = l && app.cat.tool(l.tool);
        return idx >= 0 ? `${idx + 1} ${t ? t.name : ''}` : '';
      })() : '';
      const li = h('li.' + d.level, h('span.where', { text: where }), h('span', { text: d.msg }));
      if (d.fix) li.append(h('button.btn', { text: d.fix.label, onclick: () => app.applyFix(d.fix) }));
      list.append(li);
    }
    if (r.errors) {
      list.append(h('li.info', h('label', h('input', { type: 'checkbox', checked: app.ack, onchange: (e) => { app.ack = e.target.checked; app.changed('value'); } }),
        ' Copy anyway: I have read the errors and accept a line that may not do what the summary says.')));
    }
    // inspector
    ui.$('#summary').textContent = r.summary || 'Nothing built yet.';
    const meta = ui.clear(ui.$('#meta'));
    if (r.ttps.length) {
      const g = h('div.grp', h('b', { text: 'ATT&CK' }));
      for (const t of r.ttps) g.append(h('span.tech', { text: t.label, title: `From ${t.from}. Click to find every tool that hunts it.`, onclick: () => app.openPalette(t.id) }));
      meta.append(g);
    }
    if (r.requires.length) meta.append(h('div.grp', h('b', { text: 'Requires' }), h('ul', r.requires.map((x) => h('li', { text: x })))));
    if (r.opsec.length) meta.append(h('div.grp', h('b', { text: 'OPSEC' }), h('ul', r.opsec.map((x) => h('li', { text: x })))));
    // structure outline: pipeline order, with nested commands shown as children
    const outline = ui.clear(ui.$('#outline'));
    const items = app.state.root.items;
    const nestedIn = (layerId) => {
      const out = [];
      const l = r.layers.find((x) => x.id === layerId);
      if (!l || !l.tool) return out;
      const seen = new Set();
      for (const p of l.tool.params || []) {
        const collect = (def, val) => {
          if (!def) return;
          if (def.type === 'command' && val && val.tool) { const t = app.cat.tool(val.tool); out.push({ pid: p.id, label: (t ? t.name : val.tool), tool: val.tool }); }
          if (def.type === 'expression' && Array.isArray(val)) for (const it of val) { const td = (def.terms || []).find((x) => x.id === it.term); if (td && td.type === 'command' && it.value && it.value.tool) { const t = app.cat.tool(it.value.tool); out.push({ pid: p.id, label: (t ? t.name : it.value.tool), tool: it.value.tool }); } }
        };
        collect(p, (items.find((x) => x.id === layerId) || { values: {} }).values[p.id]);
      }
      return out;
    };
    let showOutline = false;
    items.forEach((layer, idx) => {
      if (layer.disabled) return;
      const tool = app.cat.tool(layer.tool);
      if (idx > 0) {
        const op = (app.shell().operators || []).find((o) => o.id === app.state.root.joins[idx - 1]);
        outline.append(h('li.op', { text: op ? op.symbol : '|' }));
      }
      outline.append(h('li', { title: 'Jump to this command', onclick: () => app.focusLayerEl(layer.id) }, String(idx + 1) + '  ' + (tool ? tool.name : layer.tool)));
      for (const n of nestedIn(layer.id)) {
        showOutline = true;
        outline.append(h('li.nest', { title: 'Nested command', onclick: () => app.focusLayerEl(layer.id) }, h('span.ind', { text: '  └ ' }), n.label));
      }
    });
    ui.$('#outlineHdr').hidden = !(showOutline || items.length > 2);
    ui.$('#outline').hidden = ui.$('#outlineHdr').hidden;

    const map = ui.clear(ui.$('#tokmap'));
    r.tokens.forEach((t, i) => {
      if (t.role === 'newline') return;
      map.append(h('li.r-' + t.role, { 'data-i': i }, h('code', { text: t.text }), h('span', { text: t.explain || '' })));
    });
    // layer headers show their own command when collapsed
    for (const el of document.querySelectorAll('[data-ltext]')) el.textContent = r.layerText[el.dataset.ltext] || '';
    ui.markFields(app, r);
  };

  // token ↔ explanation highlighting (one listener each, set up once)
  ui.wireHighlight = function () {
    const line = ui.$('#line');
    const map = ui.$('#tokmap');
    const set = (i, on) => {
      for (const el of document.querySelectorAll(`#line .t[data-i="${i}"], #tokmap li[data-i="${i}"]`)) el.classList.toggle('hl', on);
      const tokEl = document.querySelector(`#line .t[data-i="${i}"]`);
      // highlight the other tokens of the same parameter too (flag + value)
      if (tokEl && tokEl.dataset.param) for (const el of document.querySelectorAll(`#line .t[data-layer="${tokEl.dataset.layer}"][data-param="${tokEl.dataset.param}"]`)) el.classList.toggle('hl', on);
    };
    const handler = (on) => (e) => {
      const el = e.target.closest('[data-i]');
      if (!el) return;
      set(el.dataset.i, on);
      if (on && e.currentTarget === line) {
        const li = map.querySelector(`li[data-i="${el.dataset.i}"]`);
        if (li) li.scrollIntoView({ block: 'nearest' });
      }
    };
    line.addEventListener('mouseover', handler(true));
    line.addEventListener('mouseout', handler(false));
    map.addEventListener('mouseover', handler(true));
    map.addEventListener('mouseout', handler(false));
    line.addEventListener('click', (e) => {
      const el = e.target.closest('[data-layer]');
      if (!el || !el.dataset.layer) return;
      const f = document.querySelector(`.field[data-layer="${el.dataset.layer}"][data-param="${el.dataset.param}"] input, .field[data-layer="${el.dataset.layer}"][data-param="${el.dataset.param}"] select, .field[data-layer="${el.dataset.layer}"][data-param="${el.dataset.param}"] textarea`);
      if (f) { f.closest('details') && (f.closest('details').open = true); f.focus(); f.scrollIntoView({ block: 'center' }); }
    });
  };
})(typeof window !== 'undefined' ? window : globalThis);
