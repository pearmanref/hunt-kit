/* L3 — the assembler: BuildState → tokens → string.
 *
 *   resolve   value refs (IOC sets, recipe variables) → literal values; apply bulk strategy + quirks
 *   validate  types, required, conflicts, versions → diagnostics
 *   render    each layer → tokens via the tool template, flag styles and the L0 quoting layer
 *   join      layers + operators (with version fallbacks) + redirections → one token list
 *
 * Every visible output (the line, the token-mapped explanation, the summary, the copied text)
 * is derived from the same token list, so they cannot disagree. The UI never edits the string.
 *
 * Values in state: plain JSON literals (string, number, boolean, array) or references:
 *   {ioc:{set, type, mode:'one', value}}            one IOC (value is the snapshot)
 *   {ioc:{set, type, mode:'all', strategy}}         every IOC of that type in the set
 *   {var:'name'}                                    recipe variable, bound before assembly
 */
(function (root) {
  'use strict';
  const CL = (root.CL = root.CL || {});

  const MARK = '\u0002'; // loop-variable placeholder inside a value
  const BULK_WARN_AT = 50;

  // ---------------------------------------------------------------- quoting dispatch
  function quote(shell, s, opts) {
    opts = opts || {};
    const strat = shell.quoting.strategy;
    if (String(s).includes(MARK)) return quoteWithRef(shell, String(s), opts);
    if (strat === 'posix') return CL.quote.posix(s, { zsh: !!shell.quoting.zsh, expand: opts.expand });
    if (strat === 'powershell') {
      if (opts.expand && /\$env:[A-Za-z_]/i.test(s)) return { text: pwshExpand(s), diags: [] };
      return CL.quote.pwsh(s);
    }
    if (strat === 'cmd') return CL.quote.cmd(s, { prefix: opts.prefix, expand: opts.expand });
    throw new Error('unknown quoting strategy ' + strat);
  }

  /** PowerShell "…" that keeps $env:NAME live and escapes every other expansion character. */
  function pwshExpand(s) {
    const parts = String(s).split(/(\$env:[A-Za-z_][A-Za-z0-9_]*)/i);
    return '"' + parts.map((p, i) => (i % 2 ? p.replace(/^\$env:(\w+)$/i, '${env:$1}') : p.replace(/[`"“”„$]/g, (c) => '`' + c))).join('') + '"';
  }

  /** Quote a value that contains the loop-variable placeholder. */
  function quoteWithRef(shell, s, opts) {
    const L = shell.loop;
    const strat = shell.quoting.strategy;
    if (s === MARK) return { text: (opts.prefix || '') + L.ref, diags: [] };
    if (strat === 'posix') {
      const text = s.split(MARK).map((p) => (p ? CL.quote._posixLiteral(p, shell.quoting.zsh) : '')).join(L.ref);
      return { text: (opts.prefix || '') + text, diags: [] };
    }
    if (strat === 'powershell') {
      return { text: CL.quote.pwshDouble(s).split(MARK).join(L.refInString), diags: [] };
    }
    const r = CL.quote.cmd(s, { prefix: opts.prefix, expand: true });
    r.text = r.text.split(MARK).join(L.refInString);
    return r;
  }

  function loopItems(shell, items) {
    const strat = shell.quoting.strategy;
    if (strat === 'posix') return items.map((v) => CL.quote._posixLiteral(String(v), shell.quoting.zsh)).join(' ');
    if (strat === 'powershell') return items.map((v) => CL.quote.pwshString(v)).join(',');
    return items.map((v) => '"' + v + '"').join(' ');
  }

  // ---------------------------------------------------------------- helpers
  const isRef = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const present = (v) => !(v === undefined || v === null || v === '' || v === false || (Array.isArray(v) && v.length === 0));

  function display(v) {
    if (Array.isArray(v)) {
      if (v.length === 1) return display(v[0]);
      if (v.length <= 3) return v.slice(0, -1).map(display).join(', ') + ' or ' + display(v[v.length - 1]);
      return `any of ${v.length} values`;
    }
    if (v === MARK) return 'each IOC in turn';
    if (typeof v === 'boolean') return '';
    if (typeof v === 'number' || /^-?\d+$/.test(String(v))) return String(v);
    return `'${String(v).replace(new RegExp(MARK, 'g'), '<ioc>')}'`;
  }

  function flagText(p, prefs) {
    if (!p.flag) return null;
    if (typeof p.flag === 'string') return p.flag;
    return prefs.longFlags ? p.flag.long || p.flag.short : p.flag.short || p.flag.long;
  }

  function tok(text, role, extra) {
    return Object.assign({ text, role }, extra || {});
  }

  // ---------------------------------------------------------------- value resolution
  /** Returns {value, bulk:{strategy, items, type, setName}|null} for one param. */
  function resolveValue(raw, ctx, diags, ref) {
    if (!isRef(raw)) return { value: raw, bulk: null };
    if (raw.var !== undefined) {
      const bound = ctx.vars && ctx.vars[raw.var];
      if (bound === undefined) {
        diags.push(CL.diag('error', 'unbound-var', `Recipe variable {{${raw.var}}} has no value.`, ref));
        return { value: `<${raw.var}>`, bulk: null };
      }
      return resolveValue(bound, ctx, diags, ref);
    }
    if (raw.ioc) {
      const i = raw.ioc;
      if (i.mode !== 'all') return { value: i.value, bulk: null };
      const set = ctx.iocSets && ctx.iocSets[i.set];
      if (!set) {
        diags.push(CL.diag('error', 'ioc-set-missing', `IOC set "${i.set}" is not loaded.`, ref));
        return { value: `<${i.type} IOCs>`, bulk: null };
      }
      const items = [...new Set((set.items || []).filter((x) => x.type === i.type).map((x) => x.value))];
      if (!items.length) {
        diags.push(CL.diag('error', 'ioc-empty', `Set "${set.name}" has no ${i.type} IOCs.`, ref));
        return { value: `<${i.type} IOCs>`, bulk: null };
      }
      return { value: items, bulk: { strategy: i.strategy || 'multi', items, type: i.type, setName: set.name } };
    }
    if (raw.lit !== undefined) return { value: raw.lit, bulk: null };
    return { value: raw, bulk: null };
  }

  // ---------------------------------------------------------------- one layer
  /**
   * @param layer   state layer
   * @param env     {cat, shell, version, ctx, prefs, bind:{loop:{layer,param}|null, line:{layer,param,item}|null}}
   * @returns {tokens, diags, tool, bulk, values}
   */
  function renderLayer(layer, env) {
    const { cat, shell, version, ctx, prefs } = env;
    const diags = [];
    const L = layer.id;
    const tool = cat.tool(layer.tool);
    if (!tool) {
      diags.push(CL.diag('error', 'unknown-tool', `Unknown tool "${layer.tool}".`, { layer: L }));
      return { tokens: [tok(`<${layer.tool}?>`, 'missing', { layer: L })], diags, tool: null, values: {} };
    }
    const tShell = cat.toolShell(tool, shell.id, version);
    if (!tShell) diags.push(CL.diag('error', 'wrong-shell', `${tool.name} does not run in ${shell.name}.`, { layer: L }));
    else if (tShell._versionBlocked) diags.push(CL.diag('error', 'version', `${tool.name} needs ${shell.name} ${tShell.minVersion}+.`, { layer: L }));

    // 1. resolve values
    const values = {};
    let bulk = null;
    for (const p of tool.params || []) {
      if (!(p.id in (layer.values || {}))) continue;
      const r = resolveValue(layer.values[p.id], ctx, diags, { layer: L, param: p.id });
      values[p.id] = r.value;
      if (r.bulk) {
        if (bulk) diags.push(CL.diag('error', 'bulk-twice', 'Only one parameter per layer can take a whole IOC set.', { layer: L, param: p.id }));
        else bulk = Object.assign({ param: p.id }, r.bulk);
      }
    }
    // a line-per-IOC render binds one item; a loop render binds the placeholder
    if (env.bind && env.bind.line && env.bind.line.layer === L) values[env.bind.line.param] = env.bind.line.item;
    if (env.bind && env.bind.loop && env.bind.loop.layer === L) values[env.bind.loop.param] = MARK;

    // 2. bulk strategy
    if (bulk) {
      const p = tool.params.find((x) => x.id === bulk.param);
      const cfg = (p.bulk || {})[bulk.strategy];
      const n = bulk.items.length;
      if (bulk.strategy === 'multi' || bulk.strategy === 'alternation') {
        if (!cfg) {
          diags.push(CL.diag('error', 'bulk-unsupported', `${tool.name} ${p.label || p.id} cannot take several values at once (${bulk.strategy}). Use loop or one line per IOC.`, { layer: L, param: p.id }));
        } else if (bulk.strategy === 'alternation') {
          const d = cfg.dialect;
          if (!CL.regexAlternation[d]) diags.push(CL.diag('error', 'no-alternation', `This regex dialect (${d}) has no | alternation.`, { layer: L, param: p.id }));
          values[p.id] = bulk.items.map((x) => CL.regexEscape(x, d)).join('|');
        }
        if (cfg) Object.assign(values, CL.clone(cfg.set || {}));
        if (n > BULK_WARN_AT) diags.push(CL.diag('warn', 'bulk-large', `${n} values inline makes a very long line; loop mode is more reliable above ${BULK_WARN_AT}.`, { layer: L, param: p.id }));
      } else if (bulk.strategy === 'loop' || bulk.strategy === 'lines') {
        if (cfg && cfg.set) Object.assign(values, CL.clone(cfg.set));
      }
    }

    // 3. quirks: known tool bugs recorded as data
    for (const q of tool.quirks || []) {
      const w = q.when || {};
      let hit = true;
      if (w.countGt) for (const [pid, n] of Object.entries(w.countGt)) {
        const v = values[pid];
        const cnt = Array.isArray(v) ? v.length : present(v) ? 1 : 0;
        if (!(cnt > n)) hit = false;
      }
      for (const pid of w.unset || []) if (present(values[pid])) hit = false;
      for (const pid of w.set || []) if (!present(values[pid])) hit = false;
      if (w.equals) for (const [pid, val] of Object.entries(w.equals)) if (values[pid] !== val) hit = false;
      if (!hit) continue;
      if (q.apply) Object.assign(values, CL.clone(q.apply));
      diags.push(CL.diag(q.level || 'info', 'quirk:' + q.id, q.reason, { layer: L }));
    }

    // 4. validate + render params
    const paramById = new Map((tool.params || []).map((p) => [p.id, p]));
    const slotTokens = {};
    const flagTokens = [];
    const compositesDone = new Set();
    const ttEnv = { tool, shell, version, prefs, diags, L, paramById, values, env };
    let endOptsNeeded = false;

    for (const p of tool.params || []) {
      const v = values[p.id];
      const has = present(v);
      if (has) {
        for (const c of p.conflicts || []) if (present(values[c])) {
          const other = paramById.get(c);
          diags.push(CL.diag('error', 'conflict', `${p.label || p.id} conflicts with ${(other && (other.label || other.id)) || c}.`, { layer: L, param: p.id }));
        }
        for (const c of p.requires || []) if (!present(values[c])) {
          const other = paramById.get(c);
          diags.push(CL.diag('error', 'requires', `${p.label || p.id} needs ${(other && (other.label || other.id)) || c}.`, { layer: L, param: p.id }));
        }
        if (!CL.versionOk(p, version)) diags.push(CL.diag('error', 'param-version', `${p.label || p.id} needs ${shell.name} ${p.minVersion}+.`, { layer: L, param: p.id }));
        if (p.shells && !p.shells.includes(shell.id)) diags.push(CL.diag('error', 'param-shell', `${p.label || p.id} is not available in ${shell.name}.`, { layer: L, param: p.id }));
      }
      if (p.composite) {
        if (!compositesDone.has(p.composite)) {
          compositesDone.add(p.composite);
          const comp = (tool.composites || []).find((c) => c.id === p.composite);
          const ct = renderComposite(comp, ttEnv);
          if (comp.slot) (slotTokens[comp.slot] = slotTokens[comp.slot] || []).push(...ct);
          else flagTokens.push(...ct);
        }
        continue;
      }
      if (!has) {
        const req = p.required && !(p.requiredUnless || []).some((o) => present(values[o]));
        if (req) {
          diags.push(CL.diag('error', 'required', `${p.label || p.id} is required.`, { layer: L, param: p.id }));
          const t = [tok(`<${p.label || p.id}>`, 'missing', { layer: L, param: p.id, explain: p.desc || '' })];
          if (p.slot) (slotTokens[p.slot] = slotTokens[p.slot] || []).push(...t);
          else flagTokens.push(...t);
        }
        continue;
      }
      const r = renderParam(p, v, ttEnv);
      if (r.endOpts) endOptsNeeded = true;
      const enumLabel = (x) => { const e = (p.enum || []).find((y) => String(y.value !== undefined ? y.value : y) === String(x)); return e && e.label ? e.label : String(x); };
      const structural = p.type === 'datetime' || p.type === 'command' || p.type === 'expression';
      const shown = p.type === 'enum' ? [].concat(v).map(enumLabel).join(', ') : display(v);
      const whole = structural ? null : CL.fill(p.explain || p.desc || p.label || p.id, { value: shown });
      for (const tk of r.tokens) tk.pexplain = whole || tk.explain;
      if (p.slot) (slotTokens[p.slot] = slotTokens[p.slot] || []).push(...r.tokens);
      else flagTokens.push(...r.tokens);
    }

    // 5. template
    const binary = (tShell && tShell.binary) || tool.binary || tool.name;
    const tokens = [];
    let endOptsDone = false;
    for (const part of String(tool.template || '{binary} {flags}').split(/\s+/)) {
      if (!part) continue;
      if (part === '{binary}') tokens.push(tok(binary, 'binary', { layer: L, explain: tool.summary }));
      else if (part === '{flags}') tokens.push(...flagTokens);
      else if (/^\{\w+\}$/.test(part)) {
        const st = slotTokens[part.slice(1, -1)] || [];
        if (st.length && endOptsNeeded && !endOptsDone && st[0].positional) {
          tokens.push(tok(tool.endOfOptions, 'flag', { layer: L, explain: 'ends option parsing, so a value starting with - is not read as an option' }));
          endOptsDone = true;
        }
        tokens.push(...st);
      } else tokens.push(tok(part, 'fixed', { layer: L, explain: (tool.fixedExplain || {})[part] || tool.summary }));
    }

    // 6. redirections attached to this layer
    for (const rd of layer.redirs || []) {
      const def = (shell.redirections || []).find((x) => x.id === rd.op);
      if (!def) { diags.push(CL.diag('error', 'redir', `${shell.name} has no redirection "${rd.op}".`, { layer: L })); continue; }
      tokens.push(tok(def.symbol, 'redir', { layer: L, explain: def.desc }));
      if (def.target === 'path') {
        if (!present(rd.target)) {
          diags.push(CL.diag('error', 'redir-target', 'Redirection needs a file name.', { layer: L }));
          tokens.push(tok('<file>', 'missing', { layer: L }));
        } else {
          const q = quote(shell, rd.target, {});
          diags.push(...q.diags.map((d) => Object.assign(d, { ref: { layer: L } })));
          tokens.push(tok(q.text, 'redir', { layer: L, explain: `${def.desc} → ${rd.target}`, target: true }));
        }
      }
    }
    return { tokens, diags, tool, bulk, values };
  }

  /** Render one non-composite param to tokens. */
  function renderParam(p, v, t) {
    const { shell, prefs, diags, L } = t;
    const ref = { layer: L, param: p.id };
    const explainOf = (val) => CL.fill(p.explain || p.desc || p.label || p.id, { value: display(val) });

    // nested command (find -exec, xargs, sudo/timeout/env) and expression lists (find tests)
    if (p.type === 'command') return renderNested(p, v, t);
    if (p.type === 'expression') return renderExpression(p, v, t);

    // bool / switch
    if (p.type === 'bool') {
      return { tokens: [tok(flagText(p, prefs), 'flag', { layer: L, param: p.id, explain: explainOf(true) })] };
    }
    // enum rendered as its own flag (Where-Object -Like, -Match …)
    if (p.type === 'enum' && p.asFlag) {
      const ok = (p.enum || []).some((e) => (e.value || e) === v);
      if (!ok) diags.push(CL.diag('error', 'enum', `${p.label}: "${v}" is not one of the allowed values.`, ref));
      const e = (p.enum || []).find((x) => (x.value || x) === v);
      return { tokens: [tok(String(v), 'flag', { layer: L, param: p.id, explain: CL.fill(p.explain || '{value}', { value: (e && e.label) || v }) })] };
    }

    let items = Array.isArray(v) ? v.map(String) : [v];
    let flag = flagText(p, prefs);
    let encoder = p.encode;
    // a sibling switch can change how the value must be escaped (findstr /r vs literal)
    if (p.encodeIf) for (const [pid, e] of Object.entries(p.encodeIf)) if (present(t.values[pid])) encoder = e;

    // datetime: the mode picks the flag and encoder (find: -mmin vs -newermt)
    if (p.type === 'datetime' && items[0] !== MARK) {
      const w = CL.parseWhen(items[0]);
      if (!w) {
        diags.push(CL.diag('error', 'datetime', `${p.label}: use 24h / 7d / 30m or YYYY-MM-DD [HH:MM].`, ref));
        return { tokens: [tok(`<${p.label}>`, 'missing', ref)] };
      }
      const m = (p.modes || {})[w.mode] || {};
      if (m.flag) flag = m.flag;
      if (m.encode) encoder = m.encode;
      const e = CL.encode(encoder || 'plain', items[0]);
      const q = e.kind === 'expr' ? { text: e.text, diags: [] } : quote(shell, e.text, {});
      diags.push(...q.diags.map((d) => Object.assign(d, { ref })));
      const ex = CL.fill(p.explain || p.label, { value: CL.describeWhen(w) });
      return { tokens: assemblePair(flag, q.text, p, ex, L, false) };
    }

    // validation per item
    for (const it of items) {
      if (it === MARK) continue;
      if (p.type === 'int' && !/^-?\d+$/.test(it)) diags.push(CL.diag('error', 'int', `${p.label}: "${it}" is not a whole number.`, ref));
      if (p.type === 'int' && p.min !== undefined && Number(it) < p.min) diags.push(CL.diag('error', 'int-min', `${p.label}: minimum is ${p.min}.`, ref));
      if (p.type === 'enum' && !(p.enum || []).some((e) => String(e.value !== undefined ? e.value : e) === it)) diags.push(CL.diag('error', 'enum', `${p.label}: "${it}" is not one of the allowed values.`, ref));
      if (p.validate && !new RegExp(p.validate).test(it)) diags.push(CL.diag('error', 'format', `${p.label}: ${p.validateMsg || 'unexpected format'} ("${it}").`, ref));
      if (p.type === 'regex' && p.regexDialect === 'findstr' && /\|/.test(it) && !p.allowPipe) diags.push(CL.diag('warn', 'findstr-pipe', 'findstr has no | alternation; it matches a literal |. Use several /c: strings instead.', ref));
    }
    if (items.length > 1 && !p.repeatable && !p.repeat) diags.push(CL.diag('error', 'not-repeatable', `${p.label} takes one value.`, ref));

    // path conventions per shell
    if (p.type === 'path') items = items.map((it) => convertPath(it, p, shell, diags, ref));

    // PowerShell: [ ] in a literal path are wildcards to -Path; switch to -LiteralPath
    if (p.literalFlag && shell.quoting.strategy === 'powershell') {
      const br = items.some((it) => /[\[\]]/.test(it));
      const wild = items.some((it) => /[*?]/.test(it));
      if (br && !wild) { flag = p.literalFlag; diags.push(CL.diag('info', 'literal-path', `Used ${p.literalFlag}: [ and ] are wildcard characters to ${flagText(p, prefs)}.`, ref)); }
      else if (br && wild) diags.push(CL.diag('warn', 'path-brackets', '[ ] and * in one path: PowerShell treats [ ] as a wildcard range here. Escape them with ` if they are literal.', ref));
    }

    // encode + quote each item
    const enc = (it) => {
      if (it === MARK) {
        if (encoder && encoder !== 'plain' && encoder !== 'strip-exe') diags.push(CL.diag('warn', 'loop-unencoded', `Loop values reach ${t.tool.name} without the ${encoder} escaping a fixed value would get.`, ref));
        return { text: (p.valuePrefix || '') + MARK, kind: 'string' };
      }
      try {
        const e = encoder ? CL.encode(encoder, it) : { text: it, kind: 'string' };
        if (p.valueTemplate) e.text = CL.fill(p.valueTemplate, { v: e.text });
        if (p.valuePrefix) e.text = p.valuePrefix + e.text;
        return e;
      } catch (err) {
        diags.push(CL.diag('error', 'encode', `${p.label}: ${err.message}`, ref));
        return { text: it, kind: 'string' };
      }
    };
    const expand = !!p.expand;
    // raw code (script blocks) is the analyst's own PowerShell: emitted as written, never re-quoted
    if (p.rawCode) diags.push(CL.diag('info', 'raw-code', `${p.label} is PowerShell code and is passed as written; Command Lens only checks that its brackets and quotes balance.`, ref));
    const qItem = (it, prefix) => {
      const e = enc(it);
      if (e.kind === 'expr') return e.text;
      const q = quote(shell, e.text, { expand, prefix });
      diags.push(...q.diags.map((d) => Object.assign(d, { ref })));
      return q.text;
    };

    const style = p.flagStyle || 'space';
    const rep = p.repeat || {};
    const out = [];
    let endOpts = false;
    const startsDash = (it) => it !== MARK && /^[-–—]/.test(it);
    const useRepeatFlag = rep.mode === 'flag' && rep.flag && (items.length > 1 || items.some(startsDash) || flag);

    if (items.length > 1 && rep.mode === 'join') {
      const text = items.map((it) => qItem(it)).join(rep.sep || ',');
      out.push(...assemblePair(flag, text, p, explainOf(items), L, !flag));
    } else if (useRepeatFlag) {
      for (const it of items) {
        const f = rep.flag;
        if (style === 'colon' && shell.quoting.strategy === 'cmd') out.push(tok(qItem(it, f), 'value', { layer: L, param: p.id, explain: explainOf(it), flagged: true }));
        else out.push(...assemblePair(f, qItem(it), p, explainOf(it), L, false, style));
      }
    } else {
      for (const it of items) {
        if (!flag && startsDash(it) && shell.quoting.strategy === 'posix') {
          if (t.tool.endOfOptions) endOpts = true;
          else diags.push(CL.diag('warn', 'leading-dash', `"${it}" starts with - and may be read as an option.`, ref));
        }
        if (flag && style === 'colon' && shell.quoting.strategy === 'cmd') out.push(tok(qItem(it, flag), 'value', { layer: L, param: p.id, explain: explainOf(it), flagged: true }));
        else out.push(...assemblePair(flag, qItem(it), p, explainOf(it), L, !flag, style));
      }
    }
    return { tokens: out, endOpts };
  }

  function assemblePair(flag, valueText, p, explain, L, positional, style) {
    const base = { layer: L, param: p.id, explain };
    if (!flag) return [tok(valueText, 'value', Object.assign({ positional: !!positional }, base))];
    style = style || p.flagStyle || 'space';
    if (style === 'equals') return [tok(flag + '=' + valueText, 'flag', base)];
    if (style === 'attached' || style === 'colon') return [tok(flag + valueText, 'flag', base)];
    return [tok(flag, 'flag', base), tok(valueText, 'value', base)];
  }

  /** Path notation per shell: %VAR% ↔ $env:VAR, HKLM\ ↔ HKLM:\ */
  function convertPath(it, p, shell, diags, ref) {
    if (it === MARK) return it;
    let out = it;
    const ps = shell.quoting.strategy === 'powershell';
    if (p.pathKind === 'registry') {
      if (ps) out = out.replace(/^(HKLM|HKCU|HKCR|HKU|HKCC)\\/i, (m, h) => h.toUpperCase() + ':\\').replace(/^HKEY_LOCAL_MACHINE\\/i, 'HKLM:\\').replace(/^HKEY_CURRENT_USER\\/i, 'HKCU:\\');
      else out = out.replace(/^(HKLM|HKCU|HKCR|HKU|HKCC):\\/i, (m, h) => h.toUpperCase() + '\\');
    } else if (p.expand) {
      if (ps) out = out.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, '$$env:$1');
      else if (shell.quoting.strategy === 'cmd') out = out.replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, '%$1%');
    }
    if (out !== it) diags.push(CL.diag('info', 'path-notation', `Path written in ${shell.name} notation: ${out}`, ref));
    return out;
  }

  /** Composite: several params become one argument (hashtable, WQL filter, ss filter). */
  function renderComposite(comp, t) {
    const { tool, shell, values, paramById, diags, L, prefs } = t;
    const parts = [];
    const contributors = (tool.params || []).filter((p) => p.composite === comp.id);
    const explains = [];
    for (const p of contributors) {
      const v = values[p.id];
      if (!present(v)) {
        if (p.required) diags.push(CL.diag('error', 'required', `${p.label} is required.`, { layer: L, param: p.id }));
        continue;
      }
      if (!CL.versionOk(p, t.version)) diags.push(CL.diag('error', 'param-version', `${p.label} needs ${shell.name} ${p.minVersion}+.`, { layer: L, param: p.id }));
      for (const c of p.conflicts || []) if (present(values[c])) diags.push(CL.diag('error', 'conflict', `${p.label} conflicts with ${(paramById.get(c) || {}).label || c}.`, { layer: L, param: p.id }));
      const items = Array.isArray(v) ? v.map(String) : [String(v)];
      const enc = items.map((it) => {
        if (it === MARK) {
          if (p.encode && p.encode !== 'plain') diags.push(CL.diag('warn', 'loop-unencoded', `Loop values are inserted without ${p.encode} escaping.`, { layer: L, param: p.id }));
          // in a PowerShell expression the loop variable is a plain expression
          return comp.quote === 'none' ? shell.loop.refExpr || MARK : MARK;
        }
        if (p.type === 'int' && !/^-?\d+$/.test(it)) diags.push(CL.diag('error', 'int', `${p.label}: "${it}" is not a whole number.`, { layer: L, param: p.id }));
        if (p.type === 'enum' && !(p.enum || []).some((e) => String(e.value !== undefined ? e.value : e) === it)) diags.push(CL.diag('error', 'enum', `${p.label}: "${it}" is not one of the allowed values.`, { layer: L, param: p.id }));
        if (p.type === 'datetime' && !CL.parseWhen(it)) { diags.push(CL.diag('error', 'datetime', `${p.label}: use 24h / 7d / 30m or YYYY-MM-DD [HH:MM].`, { layer: L, param: p.id })); return it; }
        try { return p.encode ? CL.encode(p.encode, it).text : it; } catch (e) { diags.push(CL.diag('error', 'encode', `${p.label}: ${e.message}`, { layer: L, param: p.id })); return it; }
      });
      let frag;
      if (p.listJoin !== undefined && enc.length > 1) {
        frag = CL.fill(p.fragment, { v: enc.join(p.listJoin) });
      } else if (enc.length > 1) {
        frag = '(' + enc.map((x) => CL.fill(p.fragment, { v: x })).join(p.repeatJoin || ' or ') + ')';
      } else frag = CL.fill(p.fragment, { v: enc[0] });
      parts.push(frag);
      const ev = p.type === 'datetime' ? CL.describeWhen(CL.parseWhen(items[0])) : display(items.length > 1 ? items : items[0]);
      explains.push(CL.fill(p.explain || p.label, { value: ev }));
    }
    if (!parts.length) return [];
    let text = (comp.wrap ? comp.wrap[0] : '') + parts.join(comp.join || ' ') + (comp.wrap ? comp.wrap[1] : '');
    let qd = [];
    if (comp.quote === 'ps-dq') {
      text = CL.quote.pwshDouble(text).split(MARK).join(shell.loop.refInString);
    } else if (comp.quote === 'shell') {
      const q = quote(shell, text, {});
      text = q.text; qd = q.diags;
    } else if (text.includes(MARK)) {
      text = text.split(MARK).join(shell.loop.refExpr || shell.loop.ref);
    }
    diags.push(...qd.map((d) => Object.assign(d, { ref: { layer: L } })));
    const explain = (comp.explain ? comp.explain + ': ' : '') + explains.join('; ');
    const flag = comp.flag ? (typeof comp.flag === 'string' ? comp.flag : prefs.longFlags ? comp.flag.long : comp.flag.short) : null;
    if (!flag) return [tok(text, 'value', { layer: L, param: comp.id, explain, composite: true })];
    return [tok(flag, 'flag', { layer: L, param: comp.id, explain, composite: true }), tok(text, 'value', { layer: L, param: comp.id, explain, composite: true })];
  }

  /**
   * Nested command: a whole command built inside one argument of its parent.
   * find -exec <cmd> {} +, xargs <cmd>, sudo/timeout/env <cmd>. The inner command is rendered
   * as its own one-command layer and quoted for THE SAME shell (find runs -exec without a shell,
   * but the whole find line is still parsed by the shell, so each inner word is a shell word).
   * There is no chain inside, so pipes and redirections cannot appear here by construction.
   */
  function renderNested(p, v, t) {
    const { shell, prefs, diags, L, env } = t;
    const ref = { layer: L, param: p.id };
    const nest = p.nest || {};
    const flag = flagText(p, prefs);
    const out = [];
    if (!v || typeof v !== 'object' || !v.tool) {
      if (p.required) diags.push(CL.diag('error', 'required', `${p.label} needs a command.`, ref));
      if (flag) out.push(tok(flag, 'flag', { layer: L, param: p.id, explain: p.explain || p.label }));
      if (p.required) out.push(tok('<command>', 'missing', { layer: L, param: p.id, explain: p.desc || '' }));
      return { tokens: out };
    }
    const tool = env.cat.tool(v.tool);
    if (!tool) {
      diags.push(CL.diag('error', 'nested-tool', `Unknown command "${v.tool}".`, ref));
    } else {
      if (nest.toolFilter === 'exec-safe' && !tool.execSafe) {
        diags.push(CL.diag('error', 'nested-unsafe', `${tool.name} is not offered inside ${p.label}: only read-only commands that take a file path are.`, ref));
      } else if (nest.toolFilter === 'read-only' && tool.writes) {
        diags.push(CL.diag('error', 'nested-writes', `${tool.name} can change the host, so it is not offered inside ${p.label}.`, ref));
      }
      if (!env.cat.toolShell(tool, shell.id, env.version)) {
        diags.push(CL.diag('warn', 'nested-shell', `${tool.name} is not a ${shell.name} command.`, ref));
      }
    }
    // render the inner command as a standalone layer: no chain, no loop/line binding
    const childEnv = Object.assign({}, env, { bind: null });
    const sub = renderLayer({ id: L + '~' + p.id, tool: v.tool, values: v.values || {}, redirs: [] }, childEnv);
    for (const d of sub.diags) diags.push(Object.assign({}, d, { ref: { layer: L, param: p.id, inner: d.ref && d.ref.param } }));
    const inner = sub.tokens.map((tk) => Object.assign({}, tk, { layer: L, param: p.id, nested: true }));
    if (flag) out.push(tok(flag, 'flag', { layer: L, param: p.id, explain: p.explain || p.label }));
    out.push(...inner);
    if (nest.kind === 'exec') {
      if (v.at !== 'none') out.push(tok(nest.placeholder || '{}', 'value', { layer: L, param: p.id, explain: 'each path found is put here' }));
      const term = v.term || (nest.terminators && nest.terminators[0].value) || '+';
      const td = (nest.terminators || []).find((x) => x.value === term) || { value: term };
      out.push(tok(td.emit || (term === ';' ? '\\;' : term), 'punct', { layer: L, param: p.id, explain: td.explain || (term === '+' ? 'runs once for a batch of files (faster)' : 'runs once per file') }));
    }
    return { tokens: out, nestedTool: tool };
  }

  /**
   * Expression list: an ordered list of tests joined with and/or, each optionally negated, with
   * groups. Used by find (tests + operators + ( )). Each term reuses renderParam, so a test gets
   * the same validation, quoting, IOC binding and path handling as any other parameter.
   * Value: [ {term, value, negate, join} | {group:[…], negate, join} ], join = 'and' | 'or'.
   */
  function renderExpression(p, items, t) {
    const { diags, L } = t;
    const ref = { layer: L, param: p.id };
    const syn = p.syntax || {};
    const termById = new Map((p.terms || []).map((d) => [d.id, d]));
    const out = [];
    const walk = (list) => {
      list.forEach((item, i) => {
        if (i > 0) {
          const j = item.join === 'or' ? syn.or : syn.and;
          if (j) out.push(tok(j, 'operator', { layer: L, param: p.id, explain: item.join === 'or' ? 'OR (either side can match)' : 'AND (both must match)' }));
        }
        if (item.negate && syn.not) out.push(tok(syn.not, 'operator', { layer: L, param: p.id, explain: 'NOT (invert the next test)' }));
        if (item.group) {
          if (syn.lparen) out.push(tok(syn.lparen, 'punct', { layer: L, param: p.id, explain: 'group start (sets precedence)' }));
          walk(item.group);
          if (syn.rparen) out.push(tok(syn.rparen, 'punct', { layer: L, param: p.id, explain: 'group end' }));
          return;
        }
        const def = termById.get(item.term);
        if (!def) { diags.push(CL.diag('error', 'term', `Unknown test "${item.term}".`, ref)); out.push(tok('<?>', 'missing', { layer: L, param: p.id })); return; }
        const sp = Object.assign({}, def, { id: p.id });
        const rr = renderParam(sp, item.value === undefined ? true : item.value, t);
        const ex = CL.fill(def.explain || def.label || def.id, { value: display(item.value === undefined ? true : item.value) });
        for (const tk of rr.tokens) { tk.layer = L; tk.param = p.id; tk.term = item.term; if (!tk.pexplain) tk.pexplain = ex; }
        out.push(...rr.tokens);
      });
    };
    walk(items || []);
    if (!out.length && p.required) diags.push(CL.diag('error', 'required', `${p.label} needs at least one test.`, ref));
    return { tokens: out };
  }

  // ---------------------------------------------------------------- chain
  function activeItems(group) {
    const items = group.items || [];
    const joins = group.joins || [];
    const out = [];
    items.forEach((it, i) => {
      if (it.disabled) return;
      out.push({ node: it, join: out.length ? joins[i - 1] : null });
    });
    return out;
  }

  function renderNode(node, env, collect) {
    if (node.kind === 'group') {
      const inner = renderGroup(node, env, collect);
      if (!node.style || node.style === 'none') return inner;
      const g = (env.shell.groups || {})[node.style];
      if (!g) { collect.diags.push(CL.diag('error', 'group-style', `${env.shell.name} has no "${node.style}" grouping.`)); return inner; }
      return [tok(g[0], 'punct', { explain: 'start of group' }), ...inner, tok(g[1], 'punct', { explain: 'end of group' })];
    }
    const r = renderLayer(node, env);
    collect.diags.push(...r.diags);
    collect.layers.push({ id: node.id, tool: r.tool, tokens: r.tokens, bulk: r.bulk, values: r.values, preset: node.preset });
    return r.tokens;
  }

  function renderGroup(group, env, collect) {
    const act = activeItems(group);
    let acc = [];
    act.forEach((a, i) => {
      const right = renderNode(a.node, env, collect);
      if (i === 0) { acc = right; return; }
      const op = (env.shell.operators || []).find((o) => o.id === a.join);
      if (!op) {
        collect.diags.push(CL.diag('error', 'operator', `${env.shell.name} has no operator "${a.join}".`, { layer: a.node.id }));
        acc = acc.concat([tok('<op?>', 'missing')], right);
        return;
      }
      if (!CL.versionOk(op, env.version)) {
        if (op.fallback) {
          const ex = `${op.desc} (${op.symbol} needs ${env.shell.name} ${op.minVersion}+, so the ${env.version} form is used)`;
          acc = applyTemplate(op.fallback, acc, right, ex);
          collect.diags.push(CL.diag('info', 'op-fallback', `${op.symbol} is ${env.shell.name} ${op.minVersion}+; used the ${env.version} equivalent.`, { layer: a.node.id }));
          collect.ops.push(op);
          return;
        }
        collect.diags.push(CL.diag('error', 'op-version', `${op.symbol} needs ${env.shell.name} ${op.minVersion}+.`, { layer: a.node.id }));
      }
      collect.ops.push(op);
      acc = acc.concat([tok(op.symbol, 'operator', { explain: op.desc, op: op.id, glue: op.symbol === ';' })], right);
    });
    return acc;
  }

  function applyTemplate(tpl, left, right, explain) {
    const out = [];
    const re = /\{left\}|\{right\}/g;
    let last = 0, m;
    const lit = (s) => {
      s = s.trim();
      if (s) for (const w of s.split(/\s+/)) out.push(tok(w, 'operator', { explain }));
    };
    while ((m = re.exec(tpl))) {
      lit(tpl.slice(last, m.index));
      out.push(...(m[0] === '{left}' ? left : right));
      last = m.index + m[0].length;
    }
    lit(tpl.slice(last));
    // "x;" — a ; directly after the left side reads better glued
    return out.map((t, i) => (t.text === ';' && i > 0 && t.role === 'operator' ? Object.assign(t, { glue: true }) : t));
  }

  /** Join tokens to text, recording offsets for highlighting. */
  function joinTokens(tokens) {
    let text = '';
    tokens.forEach((t, i) => {
      if (t.role === 'newline') { t.start = text.length; text += '\n'; t.end = text.length; return; }
      const prevNl = i > 0 && tokens[i - 1].role === 'newline';
      if (i > 0 && !t.glue && !prevNl) text += ' ';
      t.start = text.length;
      text += t.text;
      t.end = text.length;
    });
    return text;
  }

  // ---------------------------------------------------------------- entry point
  /**
   * @param state  BuildState
   * @param cat    CL.Catalog
   * @param ctx    {iocSets:{id:set}, vars:{name:value}, prefs:{longFlags}}
   */
  CL.assemble = function (state, cat, ctx) {
    ctx = ctx || {};
    const prefs = ctx.prefs || {};
    const shell = cat.shell(state.shell.id);
    if (!shell) throw new Error('unknown shell ' + state.shell.id);
    const version = shell.versions ? state.shell.version || shell.versions[shell.versions.length - 1] : null;
    const env = { cat, shell, version, ctx, prefs, bind: null };

    // first pass: find bulk strategies that change the chain shape (loop, lines)
    const probe = { diags: [], layers: [], ops: [] };
    renderGroup(state.root, env, probe);
    const shaping = probe.layers.filter((l) => l.bulk && (l.bulk.strategy === 'loop' || l.bulk.strategy === 'lines'));
    const result = { shell, version, diags: [], layers: [], ops: [] };
    let tokens;
    if (shaping.length > 1) {
      result.diags.push(CL.diag('error', 'bulk-shape', 'Only one layer can use loop or one-line-per-IOC mode.'));
    }
    const sh = shaping[0];
    if (sh && sh.bulk.strategy === 'loop') {
      if (!shell.loop) result.diags.push(CL.diag('error', 'no-loop', `${shell.name} has no loop template.`));
      env.bind = { loop: { layer: sh.id, param: sh.bulk.param } };
      const collect = { diags: [], layers: [], ops: [] };
      const body = renderGroup(state.root, env, collect);
      const ex = `repeats the command once for each of the ${sh.bulk.items.length} ${sh.bulk.type} IOCs`;
      tokens = applyLoop(shell, sh.bulk.items, body, ex);
      Object.assign(result, { diags: result.diags.concat(collect.diags), layers: collect.layers, ops: collect.ops });
      result.loop = { count: sh.bulk.items.length, type: sh.bulk.type, setName: sh.bulk.setName };
    } else if (sh && sh.bulk.strategy === 'lines') {
      tokens = [];
      let first = null;
      sh.bulk.items.forEach((item, i) => {
        env.bind = { line: { layer: sh.id, param: sh.bulk.param, item } };
        const collect = { diags: [], layers: [], ops: [] };
        const t = renderGroup(state.root, env, collect);
        if (i) tokens.push(tok('\n', 'newline', { explain: 'next line (one per IOC)' }));
        tokens.push(...t);
        if (!first) first = collect;
        else result.diags.push(...collect.diags.filter((d) => d.level === 'error'));
      });
      Object.assign(result, { diags: result.diags.concat(first.diags), layers: first.layers, ops: first.ops });
      result.lines = { count: sh.bulk.items.length, type: sh.bulk.type, setName: sh.bulk.setName };
    } else {
      const collect = { diags: [], layers: [], ops: [] };
      tokens = renderGroup(state.root, env, collect);
      Object.assign(result, { diags: result.diags.concat(collect.diags), layers: collect.layers, ops: collect.ops });
    }
    result.tokens = tokens;
    result.text = joinTokens(tokens);
    if (shell.maxLineLength && result.text.split('\n').some((l) => l.length > shell.maxLineLength)) {
      result.diags.push(CL.diag('error', 'too-long', `${shell.name} lines are limited to ${shell.maxLineLength} characters (this one is ${result.text.length}). Use loop mode or a pattern file.`));
    }
    // per-layer standalone text (for each layer's own copy button)
    result.layerText = {};
    for (const l of result.layers) {
      const tk = l.tokens.map((t) => Object.assign({}, t));
      result.layerText[l.id] = joinTokens(tk);
    }
    // de-duplicate diagnostics
    const seen = new Set();
    result.diags = result.diags.filter((d) => {
      const k = d.level + d.code + d.msg + JSON.stringify(d.ref);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (CL.explain) Object.assign(result, CL.explain(result, state, cat));
    if (CL.hints) result.diags.push(...CL.hints(result, state, cat));
    result.errors = result.diags.filter((d) => d.level === 'error').length;
    result.warnings = result.diags.filter((d) => d.level === 'warn').length;
    return result;
  };

  function applyLoop(shell, items, body, explain) {
    const L = shell.loop;
    const out = [];
    const re = /\{items\}|\{body\}/g;
    let last = 0, m;
    const lit = (s) => {
      if (!s.trim()) return;
      // keep the template's own spacing: split into words, glue punctuation to neighbours
      const words = s.trim().split(/\s+/);
      const glueStart = !/^\s/.test(s) && out.length > 0;
      words.forEach((w, i) => out.push(tok(w, 'operator', { explain, glue: i === 0 && glueStart })));
    };
    while ((m = re.exec(L.template))) {
      lit(L.template.slice(last, m.index));
      const glueNext = m.index > 0 && !/\s/.test(L.template[m.index - 1]);
      if (m[0] === '{items}') out.push(tok(loopItems(shell, items), 'value', { explain: `the ${items.length} IOC values`, glue: glueNext }));
      else {
        const b = body.map((t) => Object.assign({}, t));
        if (b.length && glueNext) b[0].glue = true;
        out.push(...b);
      }
      last = m.index + m[0].length;
      // a template char right after the placeholder (e.g. ')' or ';') glues to it
      const nx = L.template[last];
      if (nx && !/\s/.test(nx)) {
        const end = L.template.slice(last).search(/\s/);
        const w = end < 0 ? L.template.slice(last) : L.template.slice(last, last + end);
        out.push(tok(w, 'operator', { explain, glue: true }));
        last += w.length;
      }
    }
    lit(L.template.slice(last));
    return out;
  }

  CL._assembleInternals = { quote, pwshExpand, MARK, joinTokens };
})(typeof window !== 'undefined' ? window : globalThis);
