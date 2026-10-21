/* L1 — validation shared by scripts/validate.js (contributors, CI) and the in-app import.
 *
 * Two layers, on purpose:
 *   1. shape: a small JSON Schema subset (type, properties, required, additionalProperties,
 *      items, minItems, enum, pattern, minimum, anyOf, $ref to #/$defs). Zero dependencies;
 *      tests fail if a schema file uses a keyword outside this list.
 *   2. meaning: cross-references JSON Schema cannot express — unique ids and flags,
 *      conflicts/requires/template slots that exist, known encoders, ATT&CK IDs that exist
 *      (with the replacement for revoked ones), and every preset assembling without errors.
 */
(function (root) {
  'use strict';
  const CL = (root.CL = root.CL || {});

  CL.SCHEMA_KEYWORDS = new Set(['$schema', '$id', 'title', 'description', 'type', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'enum', 'pattern', 'minimum', 'anyOf', '$ref', '$defs']);

  function typeOf(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
    return typeof v;
  }
  function typeOk(v, t) {
    const actual = typeOf(v);
    if (t === 'number') return actual === 'number' || actual === 'integer';
    return actual === t;
  }

  /** @returns {string[]} errors with JSON paths */
  CL.schemaValidate = function (schema, value, rootSchema, path, errors) {
    rootSchema = rootSchema || schema;
    path = path || '$';
    errors = errors || [];
    if (schema === true || schema === undefined) return errors;
    if (schema.$ref) {
      const m = /^#\/\$defs\/(.+)$/.exec(schema.$ref);
      if (!m || !rootSchema.$defs || !rootSchema.$defs[m[1]]) { errors.push(`${path}: unresolvable $ref ${schema.$ref}`); return errors; }
      return CL.schemaValidate(rootSchema.$defs[m[1]], value, rootSchema, path, errors);
    }
    if (schema.anyOf) {
      const ok = schema.anyOf.some((s) => CL.schemaValidate(s, value, rootSchema, path, []).length === 0);
      if (!ok) errors.push(`${path}: does not match any allowed form`);
      return errors;
    }
    if (schema.type) {
      const types = [].concat(schema.type);
      if (!types.some((t) => typeOk(value, t))) { errors.push(`${path}: expected ${types.join(' or ')}, got ${typeOf(value)}`); return errors; }
    }
    if (schema.enum && !schema.enum.some((e) => e === value)) errors.push(`${path}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
    if (schema.pattern && typeof value === 'string' && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: "${value}" does not match ${schema.pattern}`);
    if (schema.minimum !== undefined && typeof value === 'number' && value < schema.minimum) errors.push(`${path}: below minimum ${schema.minimum}`);
    if (Array.isArray(value)) {
      if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: needs at least ${schema.minItems} item(s)`);
      if (schema.items) value.forEach((v, i) => CL.schemaValidate(schema.items, v, rootSchema, `${path}[${i}]`, errors));
    } else if (value && typeof value === 'object') {
      for (const r of schema.required || []) if (!(r in value)) errors.push(`${path}: missing "${r}"`);
      const props = schema.properties || {};
      for (const [k, v] of Object.entries(value)) {
        if (props[k]) CL.schemaValidate(props[k], v, rootSchema, `${path}.${k}`, errors);
        else if (schema.additionalProperties === false) errors.push(`${path}: unknown property "${k}"`);
        else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') CL.schemaValidate(schema.additionalProperties, v, rootSchema, `${path}.${k}`, errors);
      }
    }
    return errors;
  };

  /** Keywords used by a schema that the validator above does not implement. */
  CL.schemaUnsupported = function (schema, out, path) {
    out = out || [];
    path = path || '$';
    if (!schema || typeof schema !== 'object') return out;
    for (const [k, v] of Object.entries(schema)) {
      if (!CL.SCHEMA_KEYWORDS.has(k)) out.push(`${path}.${k}`);
      if (k === 'properties' || k === '$defs') for (const [pk, pv] of Object.entries(v)) CL.schemaUnsupported(pv, out, `${path}.${k}.${pk}`);
      else if (k === 'items' || k === 'additionalProperties') CL.schemaUnsupported(v, out, `${path}.${k}`);
      else if (k === 'anyOf') v.forEach((s, i) => CL.schemaUnsupported(s, out, `${path}.anyOf[${i}]`));
    }
    return out;
  };

  /**
   * Semantic checks for one tool.
   * @param tool
   * @param env {shells:Set<string>, attack:{techniques, revoked}, cat?:CL.Catalog}
   * @returns {{errors:string[], warnings:string[]}}
   */
  CL.validateTool = function (tool, env) {
    const errors = [];
    const warnings = [];
    const E = (m) => errors.push(`${tool.id}: ${m}`);
    const W = (m) => warnings.push(`${tool.id}: ${m}`);
    const params = tool.params || [];
    const ids = new Set();
    for (const p of params) {
      if (ids.has(p.id)) E(`duplicate param id "${p.id}"`);
      ids.add(p.id);
    }
    const composites = new Set((tool.composites || []).map((c) => c.id));
    for (const s of tool.shells || []) if (env.shells && !env.shells.has(s.id)) E(`unknown shell "${s.id}"`);

    // template slots ↔ params
    const slots = new Set((String(tool.template).match(/\{(\w+)\}/g) || []).map((x) => x.slice(1, -1)));
    if (!slots.has('binary')) E('template has no {binary}');
    for (const p of params) if (p.slot && !slots.has(p.slot)) E(`param "${p.id}" uses slot {${p.slot}} that the template does not have`);
    for (const c of tool.composites || []) if (c.slot && !slots.has(c.slot)) E(`composite "${c.id}" uses slot {${c.slot}} that the template does not have`);
    for (const s of slots) {
      if (s === 'binary' || s === 'flags') continue;
      if (!params.some((p) => p.slot === s) && !(tool.composites || []).some((c) => c.slot === s)) E(`template slot {${s}} has no param or composite`);
    }

    // flags: unique, unless the params sharing one are told apart by a value template or conflict
    const byFlag = new Map();
    for (const p of params) {
      const f = p.flag ? (typeof p.flag === 'string' ? [p.flag] : [p.flag.short, p.flag.long].filter(Boolean)) : [];
      for (const x of f) {
        if (!byFlag.has(x)) byFlag.set(x, []);
        byFlag.get(x).push(p);
      }
    }
    for (const [f, ps] of byFlag) {
      if (ps.length < 2) continue;
      const distinguishable = ps.every((p) => p.valueTemplate || p.valuePrefix || p.type === 'datetime') ||
        ps.every((a) => ps.every((b) => a === b || (a.conflicts || []).includes(b.id) || (b.conflicts || []).includes(a.id) || a.valuePrefix !== b.valuePrefix));
      if (!distinguishable) W(`flag ${f} is used by ${ps.map((p) => p.id).join(', ')}; paste-to-parse could not tell them apart`);
    }

    for (const p of params) {
      for (const k of ['conflicts', 'requires']) for (const r of p[k] || []) if (!ids.has(r)) E(`param "${p.id}" ${k} unknown param "${r}"`);
      if (p.type === 'enum' && !(p.enum && p.enum.length)) E(`enum param "${p.id}" has no enum values`);
      if (p.composite && !composites.has(p.composite)) E(`param "${p.id}" names unknown composite "${p.composite}"`);
      if (p.composite && !p.fragment) E(`composite param "${p.id}" has no fragment`);
      if (p.composite && p.fragment && !p.fragment.includes('{v}')) E(`fragment of "${p.id}" has no {v}`);
      if (!p.composite && !p.flag && !p.slot && !p.asFlag && !(p.modes && Object.values(p.modes).every((m) => m.flag))) E(`param "${p.id}" has no flag, slot or composite: it can never be emitted`);
      const encs = [p.encode].concat(Object.values(p.encodeIf || {})).concat(Object.values(p.modes || {}).map((m) => m.encode)).filter(Boolean);
      for (const e of encs) if (CL.encoders && !CL.encoders[e]) E(`param "${p.id}" uses unknown encoder "${e}"`);
      for (const pid of Object.keys(p.encodeIf || {})) if (!ids.has(pid)) E(`param "${p.id}" encodeIf names unknown param "${pid}"`);
      if (p.validate) { try { new RegExp(p.validate); } catch (e) { E(`param "${p.id}" validate is not a valid regex`); } }
      for (const [k, cfg] of Object.entries(p.bulk || {})) for (const sid of Object.keys((cfg && cfg.set) || {})) if (!ids.has(sid)) E(`param "${p.id}" bulk.${k}.set names unknown param "${sid}"`);
      if (p.bulk && p.bulk.alternation && !p.bulk.alternation.dialect) E(`param "${p.id}" bulk.alternation needs a dialect`);
      if (p.repeat && p.repeat.mode === 'flag' && !p.repeat.flag) E(`param "${p.id}" repeat mode "flag" needs repeat.flag`);
      if (p.type === 'datetime' && !p.encode && !p.modes) E(`datetime param "${p.id}" needs encode or modes`);
      if (p.type === 'command' && !p.nest) E(`command param "${p.id}" needs a nest descriptor`);
      if (p.type === 'expression') {
        if (!p.terms || !p.terms.length) E(`expression param "${p.id}" has no terms`);
        const termIds = new Set();
        for (const term of p.terms || []) {
          if (termIds.has(term.id)) E(`expression "${p.id}" has duplicate term "${term.id}"`);
          termIds.add(term.id);
          const termEmits = term.flag || term.slot || term.type === 'command' || (term.modes && Object.values(term.modes).every((m) => m.flag));
          if (!termEmits) E(`term "${term.id}" of "${p.id}" has no flag`);
          if (term.type === 'enum' && !(term.enum && term.enum.length)) E(`term "${term.id}" of "${p.id}" is enum with no values`);
          if (term.type === 'command' && !term.nest) E(`term "${term.id}" of "${p.id}" is a command with no nest`);
          const te = [term.encode].concat(Object.values(term.modes || {}).map((m) => m.encode)).filter(Boolean);
          for (const e of te) if (CL.encoders && !CL.encoders[e]) E(`term "${term.id}" of "${p.id}" uses unknown encoder "${e}"`);
          if (term.validate) { try { new RegExp(term.validate); } catch (e) { E(`term "${term.id}" of "${p.id}" has an invalid validate regex`); } }
        }
      }
      if (!p.explain && !p.desc && p.type !== 'expression' && p.type !== 'command') W(`param "${p.id}" has no explain text`);
    }
    for (const q of tool.quirks || []) {
      const refs = [].concat(Object.keys((q.when || {}).countGt || {}), (q.when || {}).unset || [], (q.when || {}).set || [], Object.keys((q.when || {}).equals || {}), Object.keys(q.apply || {}));
      for (const r of refs) if (!ids.has(r)) E(`quirk "${q.id}" names unknown param "${r}"`);
    }
    const presetIds = new Set();
    for (const pr of tool.presets || []) {
      if (presetIds.has(pr.id)) E(`duplicate preset id "${pr.id}"`);
      presetIds.add(pr.id);
      for (const k of Object.keys(pr.values || {})) if (!ids.has(k)) E(`preset "${pr.id}" sets unknown param "${k}"`);
    }
    // ATT&CK
    if (env.attack) {
      const live = env.attackIds || (env.attackIds = new Set(env.attack.techniques.map((t) => t.id)));
      const check = (id, where) => {
        if (live.has(id)) return;
        if (id in env.attack.revoked) {
          const to = env.attack.revoked[id];
          E(`${where}: ${id} is revoked/deprecated in ATT&CK v${env.attack.version}${to ? ', use ' + to : ''}`);
        } else E(`${where}: ${id} is not an ATT&CK v${env.attack.version} Enterprise technique`);
      };
      for (const id of tool.ttps || []) check(id, 'ttps');
      for (const pr of tool.presets || []) for (const id of pr.ttps || []) check(id, `preset "${pr.id}"`);
    }
    // every preset must assemble cleanly in every shell the tool supports
    if (env.cat && CL.assemble) {
      for (const sh of tool.shells || []) {
        const shell = env.cat.shell(sh.id);
        if (!shell) continue;
        const versions = shell.versions ? shell.versions.filter((v) => CL.versionOk(sh, v)) : [null];
        for (const pr of tool.presets || []) for (const v of versions) {
          const st = CL.newState(sh.id, v);
          const layer = CL.newLayer(st, env.cat, tool.id, pr.id);
          CL.insertLayer(st, layer);
          let r;
          try { r = CL.assemble(st, env.cat, {}); } catch (e) { E(`preset "${pr.id}" throws in ${sh.id}: ${e.message}`); continue; }
          const errs = r.diags.filter((d) => d.level === 'error');
          if (errs.length) E(`preset "${pr.id}" has errors in ${shell.name}${v ? ' ' + v : ''}: ${errs.map((d) => d.msg).join(' | ')}`);
        }
      }
    }
    return { errors, warnings };
  };

  CL.validateShell = function (shell, env) {
    const errors = [];
    const E = (m) => errors.push(`${shell.id}: ${m}`);
    if (shell.extends && env.shells && !env.shells.has(shell.extends)) E(`extends unknown shell "${shell.extends}"`);
    const ids = new Set();
    for (const o of shell.operators || []) {
      if (ids.has(o.id)) E(`duplicate operator id "${o.id}"`);
      ids.add(o.id);
      if (o.fallback && !(o.fallback.includes('{left}') && o.fallback.includes('{right}'))) E(`operator "${o.id}" fallback needs {left} and {right}`);
      if (o.minVersion && !o.fallback) errors.push(`${shell.id}: note: operator "${o.id}" has minVersion but no fallback (an error is shown below that version)`);
    }
    if (shell.loop && !(shell.loop.template.includes('{items}') && shell.loop.template.includes('{body}'))) E('loop.template needs {items} and {body}');
    return { errors: errors.filter((e) => !e.includes(': note:')), warnings: errors.filter((e) => e.includes(': note:')) };
  };
})(typeof window !== 'undefined' ? window : globalThis);
