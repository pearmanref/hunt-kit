/* L1 — the catalog: every shell, tool, path and ATT&CK technique the UI can show, built from
 * the generated bundle (CL.DATA) plus any files the user imported (which override by id).
 * Owns: shell inheritance, search ranking, and the technique → tools/presets reverse index.
 * The reverse index is computed here, never stored, so a mapping lives in exactly one place:
 * the tool file. */
(function (root) {
  'use strict';
  const CL = (root.CL = root.CL || {});

  function merge(base, over) {
    if (Array.isArray(over) || typeof over !== 'object' || over === null) return over;
    const out = Object.assign({}, base);
    for (const k of Object.keys(over)) {
      out[k] = base && typeof base[k] === 'object' && !Array.isArray(base[k]) ? merge(base[k], over[k]) : over[k];
    }
    return out;
  }

  /** Normalise a param's flag to {short, long} (PowerShell and cmd flags are plain strings). */
  function flagOf(p) {
    if (!p.flag) return null;
    return typeof p.flag === 'string' ? { short: p.flag } : p.flag;
  }

  class Catalog {
    constructor(data, user) {
      user = user || {};
      this.data = data;
      const rawShells = Object.assign({}, data.shells, user.shells || {});
      this.shells = new Map();
      const resolve = (id, seen) => {
        if (this.shells.has(id)) return this.shells.get(id);
        const raw = rawShells[id];
        if (!raw) throw new Error('unknown shell ' + id);
        if (seen.has(id)) throw new Error('shell extends cycle at ' + id);
        seen.add(id);
        const s = raw.extends ? merge(resolve(raw.extends, seen), raw) : raw;
        this.shells.set(id, s);
        return s;
      };
      const ids = Object.keys(rawShells).sort((a, b) => (rawShells[a].order || 99) - (rawShells[b].order || 99) || a.localeCompare(b));
      for (const id of ids) resolve(id, new Set());
      // Map order = switcher order (resolve() may have inserted a parent early)
      this.shells = new Map(ids.map((id) => [id, this.shells.get(id)]));
      this.tools = new Map();
      for (const [id, t] of Object.entries(Object.assign({}, data.tools, user.tools || {}))) this.tools.set(id, t);
      this.userToolIds = new Set(Object.keys(user.tools || {}));
      this.paths = [].concat(...Object.values(data.paths || {}).map((f) => f.paths || []), user.paths || []);
      const attack = data.attack || { techniques: [], tactics: [], revoked: {} };
      this.attack = attack;
      this.tech = new Map(attack.techniques.map((t) => [t.id, t]));
      this.tactics = new Map(attack.tactics.map((t) => [t.short, t]));
      this._buildReverse();
    }

    _buildReverse() {
      this.reverse = new Map(); // techId → [{tool, preset|null}]
      const add = (id, ref) => {
        if (!this.reverse.has(id)) this.reverse.set(id, []);
        this.reverse.get(id).push(ref);
      };
      for (const t of this.tools.values()) {
        for (const id of t.ttps || []) add(id, { tool: t.id, preset: null });
        for (const p of t.presets || []) for (const id of p.ttps || []) add(id, { tool: t.id, preset: p.id });
      }
    }

    shell(id) { return this.shells.get(id); }
    tool(id) { return this.tools.get(id); }
    flagOf(p) { return flagOf(p); }
    technique(id) { return this.tech.get(id) || null; }
    techniqueLabel(id) {
      const t = this.tech.get(id);
      if (t) return `${id} ${t.fullName || t.name}`;
      if (id in this.attack.revoked) return `${id} (revoked${this.attack.revoked[id] ? ' → ' + this.attack.revoked[id] : ''})`;
      return `${id} (unknown)`;
    }

    /** The tool's entry for this shell, or null if the tool does not run there (or not at this version). */
    toolShell(tool, shellId, version) {
      const e = (tool.shells || []).find((s) => s.id === shellId);
      if (!e) return null;
      return CL.versionOk(e, version) ? e : Object.assign({ _versionBlocked: true }, e);
    }

    toolsForShell(shellId, version) {
      return [...this.tools.values()].filter((t) => {
        const e = this.toolShell(t, shellId, version);
        return e && !e._versionBlocked;
      });
    }

    /** All tools/presets hunting a technique; a parent ID (T1053) also returns its sub-techniques. */
    huntersOf(techId) {
      const out = [];
      for (const [id, refs] of this.reverse) {
        if (id === techId || id.startsWith(techId + '.')) for (const r of refs) out.push(Object.assign({ tech: id }, r));
      }
      return out;
    }

    /**
     * Ranked search across tools, presets and techniques for the current shell.
     * Returns [{kind:'tool'|'preset'|'technique', tool, preset, tech, score, label}]
     */
    search(q, shellId, version, limit) {
      q = String(q || '').trim().toLowerCase();
      limit = limit || 40;
      const tools = this.toolsForShell(shellId, version);
      const results = [];
      const shell = this.shell(shellId);
      if (!q) {
        for (const t of tools) results.push({ kind: 'tool', tool: t.id, score: 1, label: t.name });
        return results.sort((a, b) => a.label.localeCompare(b.label)).slice(0, limit);
      }
      const words = q.split(/\s+/);
      const techQuery = /^t\d{4}(\.\d{3})?$/i.test(q) ? q.toUpperCase() : null;
      const scoreText = (hay, w) => {
        hay = hay.toLowerCase();
        if (hay === w) return 10;
        if (hay.startsWith(w)) return 6;
        if (new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(hay)) return 4;
        return hay.includes(w) ? 2 : 0;
      };
      for (const t of tools) {
        let total = 0;
        for (const w of words) {
          let best = 0;
          best = Math.max(best, scoreText(t.name, w) * 3, scoreText(t.id, w) * 2);
          for (const a of t.aliases || []) best = Math.max(best, scoreText(a, w) * 3);
          best = Math.max(best, scoreText(t.category || '', w), scoreText(t.summary || '', w));
          for (const id of t.ttps || []) best = Math.max(best, scoreText(id, w) * 2);
          if (!best) { total = 0; break; }
          total += best;
        }
        if (techQuery && (t.ttps || []).some((id) => id === techQuery || id.startsWith(techQuery + '.'))) total += 20;
        if (total) results.push({ kind: 'tool', tool: t.id, score: total, label: t.name });
        for (const p of t.presets || []) {
          let ps = 0;
          for (const w of words) {
            const s = Math.max(scoreText(p.name, w) * 2, ...(p.ttps || []).map((id) => scoreText(id, w) * 2), scoreText(t.name, w));
            if (!s) { ps = 0; break; }
            ps += s;
          }
          if (techQuery && (p.ttps || []).some((id) => id === techQuery || id.startsWith(techQuery + '.'))) ps += 25;
          if (ps) results.push({ kind: 'preset', tool: t.id, preset: p.id, score: ps, label: `${t.name}: ${p.name}` });
        }
      }
      // techniques by ID or name, only when something in this shell hunts them
      if (q.length >= 3) {
        for (const tech of this.tech.values()) {
          const s = techQuery
            ? (tech.id === techQuery ? 30 : tech.id.startsWith(techQuery + '.') ? 15 : 0)
            : words.every((w) => (tech.fullName || tech.name).toLowerCase().includes(w)) ? 5 : 0;
          if (!s) continue;
          const hunters = this.huntersOf(tech.id).filter((h) => tools.some((t) => t.id === h.tool));
          results.push({ kind: 'technique', tech: tech.id, score: s + (hunters.length ? 3 : 0), hunters: hunters.length, label: this.techniqueLabel(tech.id) });
        }
      }
      // alias shadows: 'ps' typed in PowerShell is Get-Process
      const sh = shell && shell.aliasShadows && shell.aliasShadows[q];
      if (sh) {
        const target = typeof sh === 'string' ? sh : sh.is;
        const t = tools.find((x) => x.name.toLowerCase() === String(target).toLowerCase());
        if (t && CL.versionOk(typeof sh === 'object' ? sh : {}, version)) {
          const r = results.find((x) => x.kind === 'tool' && x.tool === t.id);
          if (r) { r.score += 50; r.note = `"${q}" is an alias of ${t.name} in ${shell.name}`; }
          else results.push({ kind: 'tool', tool: t.id, score: 50, label: t.name, note: `"${q}" is an alias of ${t.name} in ${shell.name}` });
        }
      }
      return results.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label)).slice(0, limit);
    }

    /** Path library entries for an OS, converted to the shell's notation. */
    pathsFor(os, kind) {
      return this.paths.filter((p) => (!os || p.os === os) && (!kind || (p.kind || 'file') === kind));
    }
  }

  CL.Catalog = Catalog;
})(typeof window !== 'undefined' ? window : globalThis);
