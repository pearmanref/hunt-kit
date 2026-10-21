/* L0 — inner-layer encoders. Each turns a value into the text a PROGRAM expects, before the
 * shell layer quotes it. Escaping order is always inside-out:
 *     IOC value → regex escape → program syntax (WQL, hashtable, findstr) → argv → shell quoting
 * kind 'string' → the result is still a plain value and gets shell-quoted by the assembler.
 * kind 'expr'   → the result is shell/PowerShell syntax already (e.g. (Get-Date).AddHours(-24))
 *                 and is emitted as-is.
 */
(function (root) {
  'use strict';
  const CL = (root.CL = root.CL || {});

  // ---------- regex dialects ----------
  const RX = {
    ere: /[\\.^$|?*+()[\]{}]/g, // grep -E, awk
    bre: /[\\.^$*[\]]/g, // grep (basic)
    dotnet: /[\\.^$|?*+()[\]{}#]/g, // Select-String, -match
    findstr: /[\\.^$*[\]]/g, // findstr /r: no | + ? ( ) { } at all
  };
  CL.regexEscape = function (s, dialect) {
    const re = RX[dialect || 'ere'];
    if (!re) throw new Error('unknown regex dialect ' + dialect);
    return String(s).replace(re, (c) => '\\' + c);
  };
  /** Dialects that support | alternation. */
  CL.regexAlternation = { ere: true, dotnet: true, bre: false, findstr: false };

  // ---------- datetime ----------
  const REL = /^\s*(\d+)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|weeks?)\s*(ago)?\s*$/i;
  const ABS = /^\s*(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?\s*Z?\s*$/;
  /** '24h', '7d', '30 min', '2026-10-01', '2026-10-01 13:00' → {mode, minutes} | {mode, date, time} | null */
  CL.parseWhen = function (s) {
    let m = REL.exec(String(s));
    if (m) {
      const n = Number(m[1]);
      const u = m[2][0].toLowerCase();
      const mult = u === 'm' ? 1 : u === 'h' ? 60 : u === 'd' ? 1440 : 10080;
      return { mode: 'rel', minutes: n * mult };
    }
    m = ABS.exec(String(s));
    if (m) {
      const [y, mo, d] = [m[1], m[2], m[3]];
      if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return null;
      return { mode: 'abs', date: `${y}-${mo}-${d}`, time: `${m[4] || '00'}:${m[5] || '00'}:${m[6] || '00'}` };
    }
    return null;
  };
  function relParts(min) {
    if (min % 1440 === 0) return { n: min / 1440, u: 'd', ps: 'AddDays', word: 'day' };
    if (min % 60 === 0) return { n: min / 60, u: 'h', ps: 'AddHours', word: 'hour' };
    return { n: min, u: 'min', ps: 'AddMinutes', word: 'minute' };
  }
  CL.describeWhen = function (w) {
    if (!w) return '';
    if (w.mode === 'abs') return `since ${w.date} ${w.time}`;
    const p = relParts(w.minutes);
    return `in the last ${p.n} ${p.word}${p.n === 1 ? '' : 's'}`;
  };

  // ---------- encoders ----------
  CL.encoders = {
    // findstr reads \ as an escape in both literal and regex search strings; \\ is always safe
    'findstr-lit': { kind: 'string', fn: (v) => String(v).replace(/\\/g, '\\\\') },
    'findstr-rx': { kind: 'string', fn: (v) => String(v) },
    // WQL string literal inside '…'
    wql: { kind: 'string', fn: (v) => String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'") },
    // WQL LIKE '%…%': wildcard chars become bracket classes, then string-escape
    'wql-like': { kind: 'string', fn: (v) => '%' + String(v).replace(/[\[%_]/g, (c) => '[' + c + ']').replace(/\\/g, '\\\\').replace(/'/g, "\\'") + '%' },
    // PowerShell expressions (used inside hashtables / arrays, never shell-quoted again)
    'ps-string': { kind: 'expr', fn: (v) => CL.quote.pwshString(v) },
    'ps-int': { kind: 'expr', fn: (v) => String(Number(v)) },
    'ps-date': {
      kind: 'expr',
      fn: (v) => {
        const w = CL.parseWhen(v);
        if (!w) throw new Error('not a time: use 24h / 7d / 30m or YYYY-MM-DD [HH:MM]');
        if (w.mode === 'abs') return `[datetime]'${w.date}T${w.time}'`;
        const p = relParts(w.minutes);
        return `(Get-Date).${p.ps}(-${p.n})`;
      },
    },
    // find -mmin N / -newermt 'YYYY-MM-DD HH:MM:SS'
    'find-time': {
      kind: 'string',
      fn: (v) => {
        const w = CL.parseWhen(v);
        if (!w) throw new Error('not a time: use 24h / 7d / 30m or YYYY-MM-DD [HH:MM]');
        return w.mode === 'rel' ? '-' + w.minutes : `${w.date} ${w.time}`;
      },
    },
    // systemd / util-linux time spec (journalctl --since, last --since)
    'systemd-time': {
      kind: 'string',
      fn: (v) => {
        const w = CL.parseWhen(v);
        if (!w) throw new Error('not a time: use 24h / 7d / 30m or YYYY-MM-DD [HH:MM]');
        if (w.mode === 'abs') return `${w.date} ${w.time}`;
        const p = relParts(w.minutes);
        return `${p.n}${p.u} ago`;
      },
    },
    // schtasks/cmd: nothing special
    plain: { kind: 'string', fn: (v) => String(v) },
    // Get-Process -Name takes the name without .exe
    'strip-exe': { kind: 'string', fn: (v) => String(v).replace(/\.exe$/i, '') },
    // PowerShell script block: the text is PowerShell code, emitted as { … } after a balance check
    'ps-scriptblock': {
      kind: 'expr',
      fn: (v) => {
        let s = String(v).trim();
        const bad = CL.psBalance(s);
        if (bad) throw new Error(bad);
        // accept text the analyst already wrapped in { }
        if (s.startsWith('{') && s.endsWith('}') && !CL.psBalance(s.slice(1, -1))) s = s.slice(1, -1).trim();
        if (!s) throw new Error('the script block is empty');
        return '{ ' + s + ' }';
      },
    },
  };

  /**
   * PowerShell bracket/quote balance check for script-block text. Returns null when balanced,
   * otherwise a message. Knows '…' (with ''), "…" (with ` and ""), # and <# #> comments.
   * Not a parser: it catches the mistakes that would make the pasted line swallow what follows.
   */
  CL.psBalance = function (s) {
    const stack = [];
    const pairs = { ')': '(', '}': '{', ']': '[' };
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '`') { i++; continue; }
      if (c === "'" || c === '\u2018' || c === '\u2019') {
        i++;
        while (i < s.length) {
          if (/['\u2018\u2019]/.test(s[i])) { if (/['\u2018\u2019]/.test(s[i + 1] || '')) { i += 2; continue; } break; }
          i++;
        }
        if (i >= s.length) return 'unclosed single-quoted string';
        continue;
      }
      if (c === '"' || c === '\u201C' || c === '\u201D') {
        i++;
        while (i < s.length) {
          if (s[i] === '`') { i += 2; continue; }
          if (/["\u201C\u201D]/.test(s[i])) { if (/["\u201C\u201D]/.test(s[i + 1] || '')) { i += 2; continue; } break; }
          i++;
        }
        if (i >= s.length) return 'unclosed double-quoted string';
        continue;
      }
      if (c === '<' && s[i + 1] === '#') { const e = s.indexOf('#>', i + 2); if (e < 0) return 'unclosed <# comment'; i = e + 1; continue; }
      if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) { const e = s.indexOf('\n', i); if (e < 0) break; i = e; continue; }
      if (c === '(' || c === '{' || c === '[') stack.push(c);
      else if (c in pairs) {
        if (stack.pop() !== pairs[c]) return `unmatched ${c}`;
      }
    }
    return stack.length ? `unclosed ${stack[stack.length - 1]}` : null;
  };

  CL.encode = function (name, value) {
    const e = CL.encoders[name];
    if (!e) throw new Error('unknown encoder ' + name);
    return { text: e.fn(value), kind: e.kind };
  };
})(typeof window !== 'undefined' ? window : globalThis);
