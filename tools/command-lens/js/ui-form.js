/* L4 — the form for one layer, generated entirely from the tool file.
 * Common params are shown; the rest sit under "More options". Inputs write into
 * layer.values and call app.changed(); they never build command text themselves. */
(function (root) {
  'use strict';
  const CL = (root.CL = root.CL || {});
  const ui = (CL.ui = CL.ui || {});
  const h = (...a) => ui.h(...a);

  const STRATEGIES = [
    { id: 'multi', label: 'all in one command', title: 'Fixed-string match on every value at once (grep -F -e …, -In, /c: …)' },
    { id: 'alternation', label: 'one regex a|b|c', title: 'Each value regex-escaped and joined with |' },
    { id: 'loop', label: 'loop, one at a time', title: 'Wrap the whole line in a for / foreach loop' },
    { id: 'lines', label: 'one line per IOC', title: 'Repeat the whole line once per value' },
  ];

  const present = (v) => !(v === undefined || v === null || v === '' || v === false || (Array.isArray(v) && !v.length));
  const isRef = (v) => v && typeof v === 'object' && !Array.isArray(v);

  function flagLabel(p, prefs) {
    if (!p.flag) return p.slot ? 'positional' : p.composite ? 'in filter' : '';
    if (typeof p.flag === 'string') return p.flag;
    return prefs.longFlags ? p.flag.long || p.flag.short : p.flag.short || p.flag.long;
  }

  function iocTypesOf(p) {
    if (!p.ioc) return [];
    return p.ioc === '*' ? CL.IOC_TYPES.map((t) => t.id) : p.ioc;
  }

  /** Values from an input: textarea → array (or single string), text → string. */
  function readInput(el, p) {
    if (el.tagName === 'TEXTAREA') {
      const vals = el.value.split(/\r?\n/).map((x) => x.trim()).filter((x) => x !== '');
      return vals.length === 0 ? undefined : vals.length === 1 ? vals[0] : vals;
    }
    const v = el.value;
    if (v === '') return undefined;
    return p.type === 'int' && /^-?\d+$/.test(v.trim()) && !p.repeatable ? v.trim() : v;
  }

  function writeValue(app, layer, p, v) {
    // binding or unbinding an IOC swaps the input for a chip, so the form must be rebuilt
    const wasRef = isRef(layer.values[p.id]);
    if (v === undefined || v === '' || v === false) delete layer.values[p.id];
    else layer.values[p.id] = v;
    app.changed(wasRef || isRef(v) ? 'structure' : 'value');
  }

  function iocMenu(app, layer, p, anchor) {
    const set = app.activeSet();
    const types = iocTypesOf(p);
    const items = [];
    if (!set) items.push({ hdr: 'No IOC set yet: create one in the IOC sets tab' });
    else {
      const inSet = (set.items || []).filter((x) => types.includes(x.type));
      const byType = {};
      for (const x of inSet) (byType[x.type] = byType[x.type] || []).push(x);
      if (!inSet.length) items.push({ hdr: `"${set.name}" has no ${types.length > 4 ? 'matching' : types.join('/')} IOCs` });
      for (const [type, list] of Object.entries(byType)) {
        items.push({ hdr: `${type} in "${set.name}"` });
        if (list.length > 1 || p.repeatable || p.bulk) {
          items.push({ label: `All ${list.length} ${type} IOCs (bulk)`, onclick: () => writeValue(app, layer, p, { ioc: { set: set.id, type, mode: 'all', strategy: defaultStrategy(p) } }) });
        }
        for (const x of list.slice(0, 40)) items.push({ label: x.value, onclick: () => writeValue(app, layer, p, { ioc: { set: set.id, type, mode: 'one', value: x.value } }) });
      }
    }
    const recent = app.recentFor(p);
    if (recent.length) {
      items.push({ sep: true }, { hdr: 'Recently used' });
      for (const r of recent) items.push({ label: r, onclick: () => writeValue(app, layer, p, r) });
    }
    ui.menu(anchor, items);
  }

  function defaultStrategy(p) {
    const b = p.bulk || {};
    return b.multi ? 'multi' : b.alternation ? 'alternation' : 'loop';
  }

  function boundChip(app, layer, p, ref) {
    const i = ref.ioc;
    const set = app.sets.get(i.set);
    const chip = h('div.iocbound', { title: `From IOC set "${set ? set.name : i.set}"` });
    if (i.mode === 'all') {
      const n = set ? (set.items || []).filter((x) => x.type === i.type).length : 0;
      chip.append(h('span', { text: `all ${n} ${i.type}` }));
      const sel = h('select', { 'aria-label': 'How to use several IOCs', onchange: (e) => { i.strategy = e.target.value; app.changed('value'); } });
      for (const s of STRATEGIES) {
        const supported = s.id === 'loop' || s.id === 'lines' || ((p.bulk || {})[s.id] !== undefined);
        sel.append(h('option', { value: s.id, text: s.label + (supported ? '' : ' (not for this tool)'), title: s.title, disabled: !supported }));
      }
      sel.value = i.strategy || defaultStrategy(p);
      chip.append(sel);
    } else {
      chip.append(h('span', { text: `${i.type}: ${i.value}` }));
    }
    chip.append(h('button.icon-btn', { text: '✕', title: 'Unbind (keep as typed value)', onclick: () => writeValue(app, layer, p, i.mode === 'one' ? i.value : undefined) }));
    return chip;
  }

  function pathMenu(app, layer, p, anchor) {
    const os = p.os || (app.shell().os === 'windows' ? 'windows' : 'linux');
    const kind = p.pathKind === 'registry' ? 'registry' : null;
    const entries = app.cat.pathsFor(os).filter((x) => (kind ? x.kind === 'registry' : x.kind !== 'registry'));
    const byTag = {};
    for (const e of entries) (byTag[(e.tags || ['other'])[0]] = byTag[(e.tags || ['other'])[0]] || []).push(e);
    const items = [];
    for (const [tag, list] of Object.entries(byTag)) {
      items.push({ hdr: tag });
      for (const e of list) items.push({ label: e.value, title: e.label, onclick: () => addPathValue(app, layer, p, e.value) });
    }
    if (!items.length) items.push({ hdr: 'No library paths for this field' });
    ui.menu(anchor, items);
  }

  function addPathValue(app, layer, p, value) {
    const cur = layer.values[p.id];
    if (p.repeatable && present(cur) && !isRef(cur)) writeValue(app, layer, p, [].concat(cur, value));
    else writeValue(app, layer, p, value);
    app.renderLayers();
  }

  /** Common + advanced field grid for a (layer, tool); reused by the main form and nested cards. */
  function paramGrid(app, layer, tool, opts) {
    opts = opts || {};
    const box = h('div');
    if (opts.presets && (tool.presets || []).length) {
      const sel = h('select', { 'aria-label': 'Preset', onchange: (e) => { if (!e.target.value) return; CL.applyPreset(layer, app.cat, e.target.value); app.changed('structure'); } });
      sel.append(h('option', { value: '', text: `Presets (${tool.presets.length})…` }));
      for (const pr of tool.presets) sel.append(h('option', { value: pr.id, text: pr.name }));
      sel.value = '';
      box.append(h('div.presets', sel, h('span.muted.small', { title: tool.description || '', text: tool.summary })));
    } else if (opts.presets) box.append(h('div.presets', h('span.muted.small', { title: tool.description || '', text: tool.summary })));
    if (opts.note) box.append(h('div.note', { text: opts.note }));
    const shell = app.shell();
    const params = tool.params || [];
    const hidden = (pp) => pp.shells && !pp.shells.includes(shell.id);
    const common = params.filter((pp) => !hidden(pp) && (pp.common || pp.required || present(layer.values[pp.id])) && CL.versionOk(pp, app.state.shell.version));
    const adv = params.filter((pp) => !hidden(pp) && !common.includes(pp));
    const grid = h('div.fgrid');
    for (const pp of common) grid.append(field(app, layer, tool, pp));
    box.append(grid);
    if (adv.length) {
      const key = layer.id + ':adv';
      const d = h('details.adv', { open: !!app.ui.advOpen[key], ontoggle: (e) => { app.ui.advOpen[key] = e.target.open; } }, h('summary', { text: `More options (${adv.length})` }));
      const g2 = h('div.fgrid');
      for (const pp of adv) g2.append(field(app, layer, tool, pp));
      d.append(g2);
      box.append(d);
    }
    return box;
  }
  ui.paramGrid = paramGrid;

  /** The regex dialect actually in force, reading sibling flags (grep -F/-E/-P/-G). */
  function regexDialectFor(app, layer, tool, p) {
    const v = layer.values;
    if (v.fixed) return 'ere';
    if (v.perl) return 'pcre';
    if (v.basic) return 'bre';
    if (v.extended) return 'ere';
    return p.regexDialect || 'ere';
  }

  function choicesMenu(app, layer, p, anchor) {
    ui.menu(anchor, (p.choices || []).map((c) => ({ label: c.label, title: c.explain || c.value, onclick: () => writeValue(app, layer, p, c.value) })));
  }

  /** Tools offered inside a nested command, filtered by the nest rule and the current shell. */
  function nestCandidates(app, p) {
    const nest = p.nest || {};
    const shell = app.shell();
    return [...app.cat.tools.values()].filter((t) => {
      if (!app.cat.toolShell(t, shell.id, app.state.shell.version)) return false;
      if (nest.toolFilter === 'exec-safe') return !!t.execSafe;
      if (nest.toolFilter === 'read-only') return !t.writes;
      return true;
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** type:'command' — a nested command built inside one argument (find -exec, xargs, sudo…). */
  function commandField(app, layer, p, wrap) {
    const nest = p.nest || {};
    const fl = flagLabel(p, app.prefs) || (nest.kind === 'exec' ? '-exec' : '');
    wrap.classList.add('wide', 'nest');
    wrap.append(h('label', { title: p.desc || '' }, p.label, p.flag ? h('code', { text: typeof p.flag === 'string' ? p.flag : p.flag.short }) : null, p.required ? h('span.badge', { text: 'required' }) : null));
    const val = isRef(layer.values[p.id]) && layer.values[p.id].tool !== undefined ? layer.values[p.id] : null;
    const picker = h('select', { 'aria-label': 'Command', onchange: (e) => {
      if (!e.target.value) { writeValue(app, layer, p, undefined); app.renderLayers(); return; }
      const keep = val && val.tool === e.target.value ? val.values : {};
      writeValue(app, layer, p, Object.assign({ term: (nest.terminators && nest.terminators[0].value) }, val || {}, { tool: e.target.value, values: keep }));
      app.renderLayers();
    } });
    picker.append(h('option', { value: '', text: 'choose a command…' }));
    for (const t of nestCandidates(app, p)) picker.append(h('option', { value: t.id, text: t.name }));
    picker.value = val ? val.tool : '';
    const head = h('div.nest-head', picker);
    if (val && nest.kind === 'exec' && (nest.terminators || []).length > 1) {
      const term = h('select', { 'aria-label': 'How often to run', title: 'How many files per run', onchange: (e) => { val.term = e.target.value; app.changed('value'); } });
      for (const td of nest.terminators) term.append(h('option', { value: td.value, text: td.label }));
      term.value = val.term || nest.terminators[0].value;
      head.append(h('span.muted.small', { text: 'run:' }), term);
    }
    wrap.append(head);
    if (val && val.tool) {
      const nt = app.cat.tool(val.tool);
      val.values = val.values || {};
      const pseudo = { id: layer.id + '/' + p.id, values: val.values, redirs: [] };
      wrap.append(h('div.nest-body', paramGrid(app, pseudo, nt, { presets: true, note: nest.kind === 'exec' ? 'Leave the path empty — find substitutes each file where {} appears.' : '' })));
    }
    return wrap;
  }

  /** type:'expression' — an ordered list of tests joined with and/or, negatable, with groups. */
  function expressionField(app, layer, p, wrap) {
    wrap.classList.add('wide', 'expr');
    wrap.append(h('label', { title: p.desc || '' }, p.label));
    const list = Array.isArray(layer.values[p.id]) ? layer.values[p.id] : [];
    if (!list.length) layer.values[p.id] = list;
    const termDefs = p.terms || [];
    const termLabel = (id) => (termDefs.find((d) => d.id === id) || {}).label || id;

    const rebuild = () => app.changed('structure');
    const bool = (tid) => (termDefs.find((d) => d.id === tid) || {}).type === 'bool';

    const renderList = (arr, container, depth) => {
      arr.forEach((item, idx) => {
        const row = h('div.exprrow', { style: depth ? 'margin-left:14px' : '' });
        if (idx > 0) {
          const jn = h('select.exprjoin', { 'aria-label': 'join', onchange: (e) => { item.join = e.target.value; rebuild(); } },
            h('option', { value: 'and', text: 'AND' }), h('option', { value: 'or', text: 'OR' }));
          jn.value = item.join === 'or' ? 'or' : 'and';
          row.append(jn);
        } else row.append(h('span.exprjoin.muted', { text: 'where' }));
        const neg = h('label.exprneg', { title: 'NOT (invert this test)' }, h('input', { type: 'checkbox', checked: !!item.negate, onchange: (e) => { item.negate = e.target.checked || undefined; rebuild(); } }), '!');
        row.append(neg);
        if (item.group) {
          const box = h('div.exprgroup');
          box.append(h('span.muted.small', { text: '( group )' }));
          item.group = item.group || [];
          renderList(item.group, box, depth + 1);
          box.append(h('button.btn.ghost.tiny', { text: '+ test', onclick: () => { item.group.push({ term: termDefs[0].id }); rebuild(); } }));
          row.append(box);
        } else {
          const sel = h('select.exprterm', { 'aria-label': 'test', onchange: (e) => { item.term = e.target.value; delete item.value; rebuild(); } });
          for (const d of termDefs) sel.append(h('option', { value: d.id, text: d.label }));
          sel.value = item.term;
          row.append(sel);
          if (!bool(item.term)) {
            const def = termDefs.find((d) => d.id === item.term);
            if (def) {
              const synth = Object.assign({}, def, { id: 'value' });
              const pseudo = { id: layer.id + '/' + p.id + '/' + depth + '-' + idx, values: item };
              const f = field(app, pseudo, app.cat.tool(layer.tool), synth);
              f.classList.add('exprval');
              row.append(f);
            }
          }
        }
        row.append(h('button.icon-btn', { text: '✕', title: 'Remove', onclick: () => { arr.splice(idx, 1); rebuild(); } }));
        container.append(row);
      });
    };
    const body = h('div.exprlist');
    renderList(list, body, 0);
    wrap.append(body);
    wrap.append(h('div.expradd',
      h('button.btn.ghost', { text: '+ Add test', onclick: () => { list.push({ term: termDefs[0].id }); rebuild(); } }),
      p.syntax && p.syntax.lparen ? h('button.btn.ghost', { text: '+ Add group ( )', title: 'A parenthesised group sets precedence when mixing AND and OR', onclick: () => { list.push({ group: [{ term: termDefs[0].id }] }); rebuild(); } }) : null));
    return wrap;
  }

  function field(app, layer, tool, p) {
    const prefs = app.prefs;
    const shell = app.shell();
    const version = app.state.shell.version;
    const v = layer.values[p.id];
    const id = `f-${layer.id}-${p.id}`;
    const blockedVersion = !CL.versionOk(p, version) || (p.shells && !p.shells.includes(shell.id));
    const wrap = h('div.field', { 'data-layer': layer.id, 'data-param': p.id });
    const fl = flagLabel(p, prefs);

    if (p.type === 'command') return commandField(app, layer, p, wrap);
    if (p.type === 'expression') return expressionField(app, layer, p, wrap);

    if (p.type === 'bool') {
      wrap.classList.add('bool');
      const cb = h('input', { type: 'checkbox', id, checked: !!v, onchange: (e) => writeValue(app, layer, p, e.target.checked || undefined) });
      wrap.append(cb, h('label', { for: id, title: p.desc || '' }, p.label, fl ? h('code', { text: fl }) : null));
      if (blockedVersion) { cb.disabled = true; wrap.append(h('span.badge', { text: `${p.minVersion}+` })); }
      return wrap;
    }

    wrap.append(h('label', { for: id, title: p.desc || '' }, p.label, fl ? h('code', { text: fl }) : null,
      p.required ? h('span.badge', { text: 'required' }) : null, blockedVersion ? h('span.badge', { text: p.minVersion ? `${p.minVersion}+` : 'n/a' }) : null));

    if (isRef(v) && v.ioc) {
      wrap.append(boundChip(app, layer, p, v));
      return wrap;
    }
    if (isRef(v) && v.var !== undefined) {
      wrap.append(h('div.iocbound', { text: `recipe variable {{${v.var}}}` }));
      return wrap;
    }

    const row = h('div.row');
    let input;
    const multi = p.repeatable && !(p.type === 'enum');
    if (p.type === 'enum') {
      input = h('select', { id, onchange: (e) => writeValue(app, layer, p, e.target.value || undefined) });
      if (!p.required || !present(v)) input.append(h('option', { value: '', text: '—' }));
      for (const e of p.enum || []) {
        const val = e.value !== undefined ? e.value : e;
        input.append(h('option', { value: val, text: e.label ? `${e.label}` : val }));
      }
      input.value = present(v) ? String(Array.isArray(v) ? v[0] : v) : '';
    } else if (multi) {
      const vals = present(v) ? [].concat(v).map(String) : [];
      input = h('textarea.vals', { id, rows: Math.max(1, Math.min(6, vals.length || 1)), placeholder: (p.placeholder || '') + (p.placeholder ? '  (one per line)' : 'one value per line'), spellcheck: false, value: vals.join('\n'),
        oninput: (e) => { e.target.rows = Math.max(1, Math.min(6, e.target.value.split('\n').length)); writeValue(app, layer, p, readInput(e.target, p)); } });
    } else {
      input = h('input', { id, type: 'text', spellcheck: false, autocomplete: 'off', placeholder: p.placeholder || (p.type === 'datetime' ? '24h, 7d, 30m or 2026-10-01 08:00' : ''), value: present(v) ? String(v) : '',
        oninput: (e) => writeValue(app, layer, p, readInput(e.target, p)) });
      if (p.type === 'int') input.inputMode = 'numeric';
    }
    if (blockedVersion) input.disabled = true;
    row.append(input);

    // suggestions: data-provided values and the path library
    const sugg = [].concat(p.suggest || []);
    if (sugg.length && input.tagName === 'INPUT') {
      const dl = h('datalist', { id: id + '-dl' });
      for (const s of sugg) dl.append(h('option', { value: s }));
      input.setAttribute('list', dl.id);
      row.append(dl);
    }
    if (p.type === 'path') {
      row.append(h('button.iocbtn', { type: 'button', title: 'Common forensic paths for this OS', text: p.pathKind === 'registry' ? 'Keys ▾' : 'Paths ▾', onclick: (e) => pathMenu(app, layer, p, e.currentTarget) }));
      if (p.pathKind !== 'registry') {
        row.append(h('button.iocbtn', { type: 'button', title: 'Pick a file. Browsers reveal only the file name, not its folder.', text: 'File name…', onclick: async () => {
          const files = await ui.pickFiles('', !!p.repeatable);
          if (!files.length) return;
          for (const f of files) addPathValue(app, layer, p, f.name);
          ui.toast('File name added. Browsers never reveal the folder, so add it in front.', 4200);
        } }));
      }
    }
    if (p.ioc) row.append(h('button.iocbtn', { type: 'button', title: 'Use a value from the active IOC set', text: 'IOC ▾', onclick: (e) => iocMenu(app, layer, p, e.currentTarget) }));
    if (p.choices && p.choices.length) row.append(h('button.iocbtn', { type: 'button', title: 'Common ready-made values', text: 'Common ▾', onclick: (e) => choicesMenu(app, layer, p, e.currentTarget) }));
    if ((p.type === 'regex' || p.regexDialect) && CL.explainRegex) {
      const dialect = regexDialectFor(app, layer, tool, p);
      row.append(h('button.iocbtn', { type: 'button', title: 'Explain this regex and test it on sample lines', text: 'Regex ⍰', onclick: () => { const cv = layer.values[p.id]; const first = Array.isArray(cv) ? cv[0] : (present(cv) && !isRef(cv) ? String(cv) : ''); CL.ui.regexWindow(first, dialect, (np) => writeValue(app, layer, p, Array.isArray(cv) ? [np].concat(cv.slice(1)) : np)); } }));
    }
    wrap.append(row);
    if (multi || (p.type === 'path' && !p.repeatable) || p.desc) {
      const note = p.desc && (p.type === 'datetime' || p.composite || p.ioc) ? p.desc : '';
      if (note) wrap.append(h('div.note', { text: note }));
    }
    if (multi || p.type === 'string' || p.type === 'regex' || p.type === 'path') wrap.classList.add(multi ? 'wide-ish' : 'txt');
    // script blocks are code: give them the full row and say what $_ is
    if (p.rawCode) { wrap.classList.add('wide'); if (p.desc && !wrap.querySelector('.note')) wrap.append(h('div.note', { text: p.desc })); }
    return wrap;
  }

  /** Re-check conflicts and diagnostics on existing inputs without rebuilding the form. */
  ui.markFields = function (app, result) {
    const errs = new Map();
    for (const d of result.diags) if (d.ref && d.ref.param && d.level === 'error') errs.set(d.ref.layer + '|' + d.ref.param, d.msg);
    for (const f of document.querySelectorAll('.field[data-param]')) {
      const key = f.dataset.layer + '|' + f.dataset.param;
      const layer = CL.allLayers(app.state).find((l) => l.id === f.dataset.layer);
      if (!layer) continue;
      const tool = app.cat.tool(layer.tool);
      const p = tool && tool.params.find((x) => x.id === f.dataset.param);
      if (!p) continue;
      // conflicts block the other control, with the reason as a tooltip
      const blocker = (p.conflicts || []).find((c) => present(layer.values[c]));
      const ctl = f.querySelector('input, select, textarea');
      if (ctl && !present(layer.values[p.id])) {
        const versionBlocked = !CL.versionOk(p, app.state.shell.version);
        ctl.disabled = !!blocker || versionBlocked;
        f.classList.toggle('blocked', !!blocker);
        f.title = blocker ? `Conflicts with ${(tool.params.find((x) => x.id === blocker) || {}).label || blocker}` : '';
      } else if (ctl) { f.classList.remove('blocked'); f.title = ''; if (CL.versionOk(p, app.state.shell.version)) ctl.disabled = false; }
      const msg = errs.get(key);
      f.classList.toggle('bad', !!msg);
      let m = f.querySelector('.msg');
      if (msg && !m) { m = h('div.msg'); f.append(m); }
      if (m) { m.textContent = msg || ''; if (!msg) m.remove(); }
    }
  };

  ui.layerForm = function (app, layer) {
    const tool = app.cat.tool(layer.tool);
    const body = h('div.layer-body');
    if (!tool) { body.append(h('p.muted', { text: `Unknown tool "${layer.tool}". Import its tool file in the Data tab.` })); return body; }

    // presets
    if ((tool.presets || []).length) {
      const sel = h('select', { 'aria-label': 'Preset', onchange: (e) => {
        if (!e.target.value) return;
        CL.applyPreset(layer, app.cat, e.target.value);
        app.changed('structure');
      } });
      sel.append(h('option', { value: '', text: `Presets (${tool.presets.length})…` }));
      for (const pr of tool.presets) sel.append(h('option', { value: pr.id, text: pr.name + (pr.ttps && pr.ttps.length ? `  [${pr.ttps.join(', ')}]` : '') }));
      sel.value = '';
      body.append(h('div.presets', sel, layer.preset ? h('span.muted.small', { text: `from preset: ${(tool.presets.find((x) => x.id === layer.preset) || {}).name || layer.preset}` }) : null,
        h('span.muted.small', { title: tool.description || '' }, tool.summary)));
    } else body.append(h('div.presets', h('span.muted.small', { title: tool.description || '' }, tool.summary)));

    const params = tool.params || [];
    const shell = app.shell();
    const hidden = (p) => p.shells && !p.shells.includes(shell.id);
    const common = params.filter((p) => !hidden(p) && (p.common || p.required || present(layer.values[p.id])) && CL.versionOk(p, app.state.shell.version));
    const adv = params.filter((p) => !hidden(p) && !common.includes(p));
    const grid = h('div.fgrid');
    for (const p of common) grid.append(field(app, layer, tool, p));
    body.append(grid);
    if (adv.length) {
      const d = h('details.adv', { open: !!app.ui.advOpen[layer.id], ontoggle: (e) => { app.ui.advOpen[layer.id] = e.target.open; } },
        h('summary', { text: `More options (${adv.length})` }));
      const g2 = h('div.fgrid');
      for (const p of adv) g2.append(field(app, layer, tool, p));
      d.append(g2);
      body.append(d);
    }

    // redirections: attached to this command, not a join, because their target is a file
    const reds = h('div.redirs');
    (layer.redirs || []).forEach((r, i) => {
      const sel = h('select', { 'aria-label': 'Redirection', onchange: (e) => { r.op = e.target.value; app.changed('structure'); } });
      for (const d of shell.redirections || []) sel.append(h('option', { value: d.id, text: `${d.symbol}  ${d.desc}` }));
      sel.value = r.op;
      const def = (shell.redirections || []).find((d) => d.id === r.op);
      const row = h('div.redir', sel);
      if (def && def.target === 'path') row.append(h('input', { type: 'text', placeholder: shell.os === 'windows' ? 'C:\\Cases\\out.txt' : '/tmp/out.txt', value: r.target || '', spellcheck: false, oninput: (e) => { r.target = e.target.value; app.changed('value'); } }));
      row.append(h('button.icon-btn', { text: '✕', title: 'Remove redirection', onclick: () => { layer.redirs.splice(i, 1); app.changed('structure'); } }));
      reds.append(row);
    });
    if ((shell.redirections || []).length) reds.append(h('div', h('button.btn.ghost', { text: '→ Redirect output…', title: 'Write output to a file or discard errors', onclick: () => { layer.redirs = layer.redirs || []; layer.redirs.push({ op: 'out', target: '' }); app.changed('structure'); } })));
    body.append(reds);
    return body;
  };
})(typeof window !== 'undefined' ? window : globalThis);
