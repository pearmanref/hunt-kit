/* L3 — explanation built from the assembled token list and the data files' templates.
 * Produces: a plain-language summary of the whole chain, the ATT&CK techniques it hunts,
 * requirements (elevation, modules) and OPSEC notes. Nothing here re-parses the string. */
(function (root) {
  'use strict';
  const CL = (root.CL = root.CL || {});

  const CONNECT = {
    pipe: ', then passes the output to ',
    'pipe-all': ', then passes output and errors to ',
    and: '; if that succeeds, ',
    or: '; if that fails, ',
    seq: '; then ',
  };

  function layerPhrase(l, first) {
    const t = l.tool;
    if (!t) return 'an unknown tool';
    const seen = new Set();
    const bits = [];
    for (const tk of l.tokens) {
      if (!tk.param || tk.role === 'missing') continue;
      const ex = tk.pexplain || tk.explain;
      if (!ex || seen.has(tk.param) || seen.has(ex)) continue;
      seen.add(tk.param);
      seen.add(ex);
      bits.push(ex);
    }
    const redirs = l.tokens.filter((tk) => tk.role === 'redir' && tk.target).map((tk) => tk.text);
    let s = `${t.name}${first ? ' ' : ', which '}${t.action || 'runs'}`;
    if (bits.length) s += ` (${bits.join('; ')})`;
    if (l.bulk && (l.bulk.strategy === 'multi' || l.bulk.strategy === 'alternation')) {
      const n = l.bulk.items.length;
      s += n === 1 ? ` against the 1 ${l.bulk.type} IOC in "${l.bulk.setName}"` : ` against all ${n} ${l.bulk.type} IOCs from "${l.bulk.setName}"`;
    }
    if (redirs.length) s += `, writing the output to ${redirs.join(', ')}`;
    return s;
  }

  CL.explain = function (result, state, cat) {
    const parts = [];
    result.layers.forEach((l, i) => {
      const op = i > 0 ? result.ops[i - 1] : null;
      // after a pipe the next tool is described as 'X, which …'; after ; && || it starts fresh
      const piped = op && (op.kind === 'pipe' || op.kind === 'pipe-all');
      parts.push((op ? CONNECT[op.kind] || CONNECT.seq : '') + layerPhrase(l, !piped));
    });
    let summary = parts.join('');
    if (summary) summary += '.';
    if (result.loop) summary = `For each of the ${result.loop.count} ${result.loop.type} IOCs in "${result.loop.setName}", one at a time: ` + summary;
    if (result.lines) summary = `One line per IOC (${result.lines.count} ${result.lines.type} IOCs from "${result.lines.setName}"). Each line: ` + summary;

    const ttps = new Map();
    const requires = [];
    const opsec = [];
    for (const l of result.layers) {
      const t = l.tool;
      if (!t) continue;
      for (const id of t.ttps || []) if (!ttps.has(id)) ttps.set(id, { id, label: cat.techniqueLabel(id), from: t.name });
      const preset = l.preset && (t.presets || []).find((p) => p.id === l.preset);
      if (preset) {
        for (const id of preset.ttps || []) ttps.set(id, { id, label: cat.techniqueLabel(id), from: `${t.name}: ${preset.name}` });
        if (preset.opsec) opsec.push(`${t.name}: ${preset.opsec}`);
      }
      const r = t.requires || {};
      if (r.elevation && r.elevation !== 'none') requires.push(`${t.name}: ${r.elevation === 'recommended' ? 'run elevated for complete results' : 'needs ' + r.elevation}${r.note ? ' (' + r.note + ')' : ''}`);
      else if (r.note) requires.push(`${t.name}: ${r.note}`);
      if (r.module) requires.push(`${t.name}: module ${r.module}`);
      if (r.os) requires.push(`${t.name}: ${r.os}`);
      const o = t.opsec || {};
      if (o.writesDisk) opsec.push(`${t.name}: writes to disk`);
      if (o.generatesLogs && o.generatesLogs.length) opsec.push(`${t.name}: may log ${o.generatesLogs.join(', ')}`);
      if (o.network) opsec.push(`${t.name}: ${o.network}`);
      if (o.slow) opsec.push(`${t.name}: ${o.slow}`);
      if (o.note) opsec.push(`${t.name}: ${o.note}`);
      if (l.tokens.some((tk) => tk.role === 'redir' && tk.target)) opsec.push(`${t.name}: the redirection writes a file on the host`);
    }
    return { summary, ttps: [...ttps.values()], requires: [...new Set(requires)], opsec: [...new Set(opsec)] };
  };
})(typeof window !== 'undefined' ? window : globalThis);
