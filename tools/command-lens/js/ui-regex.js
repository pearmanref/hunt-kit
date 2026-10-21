/* L4 — the "What this regex does" window: dialect, token-by-token breakdown, the common
 * mistakes, and a sample-line tester that only runs where the browser engine matches. */
(function (root) {
  'use strict';
  const CL = (root.CL = root.CL || {});
  const ui = (CL.ui = CL.ui || {});
  const h = (...a) => ui.h(...a);

  const DIALECT_OPTS = [
    { id: 'ere', label: 'grep -E / awk (POSIX extended)' },
    { id: 'pcre', label: 'grep -P (Perl / PCRE)' },
    { id: 'bre', label: 'grep / sed (POSIX basic)' },
    { id: 'dotnet', label: 'Select-String / -match (.NET)' },
    { id: 'findstr', label: 'findstr /r' },
  ];

  /** Open the explainer for `pattern` in `dialect`; onApply(newPattern) is called if the user edits it. */
  ui.regexWindow = function (pattern, dialect, onApply) {
    const state = { pattern: pattern || '', dialect: dialect || 'ere', lines: ui.regexWindow._lines || '' };
    const body = h('div.regexwin');
    const patIn = h('input', { type: 'text', spellcheck: false, value: state.pattern, 'aria-label': 'Pattern', oninput: (e) => { state.pattern = e.target.value; render(); } });
    const diaSel = h('select', { 'aria-label': 'Dialect', onchange: (e) => { state.dialect = e.target.value; render(); } }, DIALECT_OPTS.map((d) => h('option', { value: d.id, text: d.label })));
    diaSel.value = state.dialect;
    const toks = h('div.rx-tokens');
    const diag = h('div.rx-diag');
    const lineBox = h('textarea', { rows: 4, spellcheck: false, placeholder: 'Paste a few sample log lines to test (one per line)…', value: state.lines, oninput: (e) => { state.lines = e.target.value; ui.regexWindow._lines = e.target.value; renderTest(); } });
    const testOut = h('div.rx-test');

    function render() {
      const r = CL.explainRegex(state.pattern, state.dialect);
      ui.clear(toks);
      for (const t of r.tokens) toks.append(h('span.rx-tok.k-' + t.kind, { title: t.explain }, t.text === ' ' ? '␣' : t.text));
      ui.clear(diag);
      for (const e of r.errors) diag.append(h('div.rx-row.err', '✖ ' + e));
      for (const w of r.warnings) diag.append(h('div.rx-row.warn', '⚠ ' + w));
      for (const nn of r.notes) diag.append(h('div.rx-row.info', 'ℹ ' + nn));
      if (!r.errors.length && !r.warnings.length && !r.notes.length) diag.append(h('div.rx-row.ok', 'No common pitfalls for ' + r.dialectName + '.'));
      const seen = new Set();
      const list = h('ul.rx-list');
      for (const t of r.tokens) { const k = t.text + '|' + t.explain; if (seen.has(k)) continue; seen.add(k); list.append(h('li', h('code', { text: t.text === ' ' ? '␣' : t.text }), h('span', { text: t.explain }))); }
      legend.replaceChildren(list);
      renderTest();
    }
    function renderTest() {
      const lines = state.lines.split(/\r?\n/).filter((x) => x !== '');
      ui.clear(testOut);
      if (!lines.length) { testOut.append(h('span.muted.small', { text: 'Add sample lines above to see what matches.' })); return; }
      const r = CL.testRegex(state.pattern, state.dialect, lines);
      if (!r.ran) { testOut.append(h('div.rx-row.info', { text: 'ℹ ' + r.reason })); return; }
      for (const res of r.results) {
        testOut.append(h('div.rx-line' + (res.match ? '.hit' : ''), h('span.rx-mark', { text: res.match ? '✓' : '·' }), h('code', { text: res.line }), res.match && res.text ? h('span.rx-matchtext', { text: '→ ' + res.text }) : null));
      }
    }
    const legend = h('div.rx-legend');
    body.append(
      h('div.rx-head', h('label', { text: 'Pattern' }), patIn, diaSel),
      h('div.rx-preview', toks),
      diag,
      h('details.rx-legend-wrap', h('summary', { text: 'Every token explained' }), legend),
      h('h4', { text: 'Test against sample lines' }), lineBox, testOut);
    render();
    const actions = [{ label: 'Close', value: null }];
    if (onApply) actions.unshift({ label: 'Use this pattern', value: () => state.pattern, primary: true });
    ui.modal('What this regex does', body, actions).then((v) => { if (v != null && onApply) onApply(v); });
  };
})(typeof window !== 'undefined' ? window : globalThis);
