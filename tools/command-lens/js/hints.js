/* L3 — pipeline-aware hints, driven only by data: io types, properties with minVersion,
 * and the shell's operator kinds. Each hint may carry a fix the UI can apply in one click. */
(function (root) {
  'use strict';
  const CL = (root.CL = root.CL || {});

  const PASS_THROUGH = new Set(['where-object', 'sort-object']);

  CL.hints = function (result, state, cat) {
    const out = [];
    const layers = result.layers;
    const version = result.version;
    for (let i = 0; i < layers.length; i++) {
      const L = layers[i];
      const t = L.tool;
      if (!t) continue;
      const op = i > 0 ? result.ops[i - 1] : null;
      const piped = op && (op.kind === 'pipe' || op.kind === 'pipe-all');
      const io = t.io || {};
      // a text filter with no input file and nothing piped in waits for the keyboard
      const hasInputPath = (t.params || []).some((p) => p.type === 'path' && p.slot && L.values[p.id] !== undefined && L.values[p.id] !== '' && !(Array.isArray(L.values[p.id]) && !L.values[p.id].length));
      const takesPathInput = (t.params || []).some((p) => p.type === 'path' && (p.slot || p.flag));
      if (io.stdin === 'text' && !piped && !hasInputPath && !(t.params || []).some((p) => p.type === 'path' && p.flag && L.values[p.id])) {
        out.push(CL.diag('warn', 'no-input', `${t.name} has no ${takesPathInput ? 'file and nothing piped in' : 'piped input'}; it will wait for keyboard input.`, { layer: L.id }));
      }
      if (!piped) continue;
      const prev = layers[i - 1];
      const pt = prev.tool;
      if (!pt) continue;
      const pio = pt.io || {};
      if (pio.stdout === 'none') out.push(CL.diag('warn', 'pipe-from-none', `${pt.name} writes nothing to the pipe, so ${t.name} gets no input.`, { layer: L.id }));
      if (io.stdin === 'none') out.push(CL.diag('warn', 'pipe-ignored', `${t.name} does not read piped input; the output of ${pt.name} is discarded.`, { layer: L.id }));
      // file objects bind to -LiteralPath by property (Get-ChildItem | Select-String searches the files): no warning
      const bindsByPath = pio.emits && (io.accepts || []).includes(pio.emits);
      if (pio.stdout === 'objects' && io.stdin === 'text' && result.shell.id === 'powershell' && !bindsByPath) {
        out.push(Object.assign(CL.diag('warn', 'objects-to-text', `${pt.name} outputs objects. ${t.name} would search each object's type name, not what you see on screen. Insert Out-String -Stream between them.`, { layer: L.id }),
          { fix: { action: 'insert', tool: 'out-string', before: L.id, label: 'Insert Out-String -Stream' } }));
      }
      if (pio.stdout === 'format' && t.id !== 'out-string') {
        out.push(CL.diag('warn', 'format-piped', `${pt.name} produces display formatting, not data. Put it last (or follow it only with Out-String / a file redirection).`, { layer: L.id }));
      }
    }
    // PowerShell properties that only exist in newer versions (Get-Process CommandLine is 7+)
    if (result.shell.id === 'powershell') {
      for (let i = 0; i < layers.length; i++) {
        const L = layers[i];
        if (!L.tool || !['select-object', 'where-object', 'sort-object', 'format-list'].includes(L.tool.id)) continue;
        let src = null;
        for (let k = i - 1; k >= 0; k--) {
          const lt = layers[k].tool;
          if (!lt) break;
          if (PASS_THROUGH.has(lt.id)) continue;
          src = lt;
          break;
        }
        if (!src || !src.properties) continue;
        const props = [].concat(L.values.property || [], L.values.expand || []).map(String);
        for (const name of props) {
          const key = Object.keys(src.properties).find((k) => k.toLowerCase() === name.toLowerCase());
          const def = key && src.properties[key];
          if (def && !CL.versionOk(def, version)) {
            out.push(CL.diag('warn', 'prop-version', `${src.name} objects have no ${key} property in PowerShell ${version}; it needs ${def.minVersion}+.${def.alt ? ' Use ' + def.alt + '.' : ''} The column would be empty.`, { layer: L.id }));
          }
        }
      }
    }
    return out;
  };
})(typeof window !== 'undefined' ? window : globalThis);
