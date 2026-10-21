/* L1 — BuildState shape, history/recipe records, workspace file, and migrations.
 *
 * BuildState is the one thing the UI edits. Everything else (string, explanation, history
 * entry) is derived from it, which is what makes history reload exactly and recipes safe.
 *
 *   { v, shell:{id, version}, root:{kind:'group', style:'none', items:[Layer|Group], joins:[opId]} }
 *   Layer = { kind:'layer', id, tool, preset, values:{paramId: value}, redirs:[{op, target}], disabled, collapsed }
 *
 * joins[i] sits between items[i] and items[i+1] and belongs to the item on its right, so
 * disabling or removing an item drops its own left join and never leaves a dangling operator.
 */
(function (root) {
  'use strict';
  const CL = (root.CL = root.CL || {});

  CL.STATE_VERSION = 1;
  CL.WORKSPACE_VERSION = 1;

  CL.newState = function (shellId, version) {
    return { v: CL.STATE_VERSION, shell: { id: shellId, version: version || null }, root: { kind: 'group', style: 'none', items: [], joins: [] } };
  };

  function allLayers(group, out) {
    out = out || [];
    for (const it of group.items || []) {
      if (it.kind === 'group') allLayers(it, out);
      else out.push(it);
    }
    return out;
  }
  CL.allLayers = (state) => allLayers(state.root);

  CL.nextLayerId = function (state) {
    let n = 0;
    for (const l of CL.allLayers(state)) {
      const m = /^L(\d+)$/.exec(l.id);
      if (m) n = Math.max(n, Number(m[1]));
    }
    return 'L' + (n + 1);
  };

  /** Defaults from the tool file, then the preset's values on top. */
  CL.newLayer = function (state, cat, toolId, presetId) {
    const tool = cat.tool(toolId);
    if (!tool) throw new Error('unknown tool ' + toolId);
    const layer = { kind: 'layer', id: CL.nextLayerId(state), tool: toolId, preset: null, values: {}, redirs: [], disabled: false, collapsed: false };
    for (const p of tool.params || []) if (p.default !== undefined && p.type !== 'path') layer.values[p.id] = CL.clone(p.default);
    if (presetId) CL.applyPreset(layer, cat, presetId);
    return layer;
  };

  CL.applyPreset = function (layer, cat, presetId) {
    const tool = cat.tool(layer.tool);
    const preset = (tool.presets || []).find((p) => p.id === presetId);
    if (!preset) throw new Error('unknown preset ' + presetId);
    layer.values = {};
    for (const p of tool.params || []) if (p.default !== undefined && p.type !== 'path' && p.type !== 'bool') layer.values[p.id] = CL.clone(p.default);
    Object.assign(layer.values, CL.clone(preset.values));
    layer.preset = presetId;
    return layer;
  };

  /** Insert a layer after index `after` (or at the end), joined by `join`. */
  CL.insertLayer = function (state, layer, after, join) {
    const g = state.root;
    const idx = after === undefined || after === null ? g.items.length - 1 : after;
    g.items.splice(idx + 1, 0, layer);
    if (g.items.length > 1) {
      // the new item at idx+1 owns joins[idx]
      g.joins.splice(Math.max(idx, 0), 0, join || 'pipe');
    }
    g.joins.length = Math.max(g.items.length - 1, 0);
    return state;
  };

  CL.removeLayer = function (state, index) {
    const g = state.root;
    g.items.splice(index, 1);
    // remove the join owned by the removed item (its left join), or the first join if it was first
    g.joins.splice(Math.max(index - 1, 0), 1);
    g.joins.length = Math.max(g.items.length - 1, 0);
    return state;
  };

  /** Move item i by delta; each item keeps its own left join. */
  CL.moveLayer = function (state, i, delta) {
    const g = state.root;
    const j = i + delta;
    if (j < 0 || j >= g.items.length) return state;
    const items = g.items;
    // carry joins with their owners: build [item, ownJoin] pairs
    const pairs = items.map((it, k) => ({ it, join: k ? g.joins[k - 1] : null }));
    const [moved] = pairs.splice(i, 1);
    pairs.splice(j, 0, moved);
    g.items = pairs.map((p) => p.it);
    const joins = pairs.map((p) => p.join);
    // the new first item has no left join; give its old join to the item it displaced
    const firstJoin = joins[0];
    g.joins = joins.slice(1).map((x) => x || firstJoin || 'pipe');
    return state;
  };

  // ---------------------------------------------------------------- history
  /** IOC values a result actually used (resolved snapshot), so history stays true after a set changes. */
  function iocsUsed(state, ctx) {
    const out = [];
    for (const l of CL.allLayers(state)) {
      for (const v of Object.values(l.values || {})) {
        if (!v || typeof v !== 'object' || !v.ioc) continue;
        if (v.ioc.mode === 'all') {
          const set = ctx.iocSets && ctx.iocSets[v.ioc.set];
          for (const x of (set && set.items) || []) if (x.type === v.ioc.type) out.push({ type: x.type, value: x.value });
        } else out.push({ type: v.ioc.type, value: v.ioc.value });
      }
    }
    return out;
  }

  CL.historyRecord = function (state, result, ctx, extra) {
    extra = extra || {};
    return {
      id: CL.uid('h'),
      ts: CL.isoNow(),
      shell: result.shell.name + (result.version ? ' ' + result.version : ''),
      state: CL.clone(state),
      text: result.text,
      summary: result.summary,
      ttps: result.ttps.map((t) => t.id),
      tools: result.layers.filter((l) => l.tool).map((l) => l.tool.name),
      iocs: iocsUsed(state, ctx || {}),
      tags: extra.tags || [],
      note: extra.note || '',
      pinned: false,
      source: extra.source || 'copy',
    };
  };

  // ---------------------------------------------------------------- recipes
  /**
   * A recipe is a saved chain whose IOC fields are named variables.
   * Every IOC reference becomes {var:name}; the variable remembers its type and strategy.
   * Extra literals can be turned into variables with CL.makeVar.
   */
  CL.toRecipe = function (record, name) {
    const state = CL.clone(record.state);
    const vars = [];
    const used = {};
    for (const l of CL.allLayers(state)) {
      for (const [pid, v] of Object.entries(l.values || {})) {
        if (!v || typeof v !== 'object' || !v.ioc) continue;
        const base = v.ioc.type.replace(/[^a-z0-9]/gi, '');
        used[base] = (used[base] || 0) + 1;
        const vn = used[base] > 1 ? base + used[base] : base;
        vars.push({ name: vn, type: 'ioc:' + v.ioc.type, mode: v.ioc.mode, strategy: v.ioc.strategy || null, layer: l.id, param: pid, example: v.ioc.value || null });
        l.values[pid] = { var: vn };
      }
    }
    return { id: CL.uid('r'), name: name || record.summary.slice(0, 60), created: CL.isoNow(), state, vars, text: record.text, tags: record.tags || [] };
  };

  CL.makeVar = function (recipe, layerId, paramId, name, type) {
    const l = CL.allLayers(recipe.state).find((x) => x.id === layerId);
    if (!l) throw new Error('no layer ' + layerId);
    const example = l.values[paramId];
    l.values[paramId] = { var: name };
    recipe.vars.push({ name, type: type || 'string', mode: 'one', layer: layerId, param: paramId, example: typeof example === 'object' ? null : example });
    return recipe;
  };

  /**
   * Bind a recipe to an IOC set: each ioc variable takes every IOC of its type from the set
   * (mode 'all', keeping the recipe's strategy) or a single value when the recipe used one.
   * `overrides` sets any variable explicitly: {name: literal | {ioc:{…}}}.
   */
  CL.bindRecipe = function (recipe, set, overrides) {
    const state = CL.clone(recipe.state);
    const vars = {};
    for (const v of recipe.vars) {
      if (overrides && overrides[v.name] !== undefined) { vars[v.name] = overrides[v.name]; continue; }
      if (set && /^ioc:/.test(v.type)) {
        const type = v.type.slice(4);
        const items = (set.items || []).filter((x) => x.type === type);
        if (v.mode === 'all' || items.length > 1) vars[v.name] = { ioc: { set: set.id, type, mode: 'all', strategy: v.strategy || 'multi' } };
        else if (items.length === 1) vars[v.name] = { ioc: { set: set.id, type, mode: 'one', value: items[0].value } };
        continue;
      }
      if (v.example !== null && v.example !== undefined) vars[v.name] = v.example;
    }
    // substitute so the bound state stands alone in history
    for (const l of CL.allLayers(state)) {
      for (const [pid, val] of Object.entries(l.values || {})) {
        if (val && typeof val === 'object' && val.var !== undefined && vars[val.var] !== undefined) l.values[pid] = CL.clone(vars[val.var]);
      }
    }
    return { state, vars };
  };

  // ---------------------------------------------------------------- workspace file
  CL.newWorkspace = function () {
    return { app: 'command-lens', schemaVersion: CL.WORKSPACE_VERSION, exported: null, settings: {}, history: [], recipes: [], iocSets: [], userPaths: [], userTools: [], userShells: [] };
  };

  /** Each step upgrades from version n to n+1. Add a step when the shape changes. */
  CL.MIGRATIONS = {
    // 1: future steps go here, e.g. function (ws) { …; ws.schemaVersion = 2; return ws; }
  };

  CL.migrateWorkspace = function (ws) {
    if (!ws || ws.app !== 'command-lens') throw new Error('Not a Command Lens workspace file.');
    let v = Number(ws.schemaVersion || 1);
    if (v > CL.WORKSPACE_VERSION) throw new Error(`Workspace version ${v} is newer than this app (${CL.WORKSPACE_VERSION}). Update Command Lens.`);
    while (v < CL.WORKSPACE_VERSION) {
      const step = CL.MIGRATIONS[v];
      if (!step) throw new Error('No migration from workspace version ' + v);
      ws = step(ws);
      v = ws.schemaVersion;
    }
    return Object.assign(CL.newWorkspace(), ws);
  };

  CL.migrateState = function (s) {
    if (!s || !s.root) throw new Error('Not a Command Lens build state.');
    s.v = s.v || 1;
    return s;
  };
})(typeof window !== 'undefined' ? window : globalThis);
