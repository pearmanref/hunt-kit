/* L0 — POSIX-family quoting (bash, zsh).
 * Literal intent: the program must receive exactly these bytes.
 *   - bare word when every char is in a conservative safe set
 *   - otherwise single quotes; an embedded ' becomes '\''  (close, escaped quote, reopen)
 *   Single quotes stop $, `, \, !, globs and word splitting, so nothing inside them is special.
 * Expand intent: the shell is meant to expand ~ and the glob chars * ?; those stay bare and
 * every other segment is quoted, e.g. /home/*\/My Docs → /home/*\/'My Docs'.
 */
(function (root) {
  'use strict';
  const CL = (root.CL = root.CL || {});
  CL.quote = CL.quote || {};

  const SAFE = /^[A-Za-z0-9_@%+=:,.\/-]+$/;

  function sq(s) {
    return "'" + s.replace(/'/g, "'\\''") + "'";
  }

  function literal(s, zsh) {
    if (s === '') return "''";
    // zsh: a word starting with = is replaced by the path of that command (=ls → /usr/bin/ls)
    if (SAFE.test(s) && !(zsh && s[0] === '=')) return s;
    return sq(s);
  }

  /** Split for expand intent: [{t:'raw'|'lit', s}] */
  function segments(s) {
    const out = [];
    let i = 0;
    const m = /^~[A-Za-z0-9._-]*\/?/.exec(s); // the / after ~user must stay unquoted or bash will not expand
    if (m) { out.push({ t: 'raw', s: m[0] }); i = m[0].length; }
    let buf = '';
    for (; i < s.length; i++) {
      const c = s[i];
      if (c === '*' || c === '?') {
        if (buf) out.push({ t: 'lit', s: buf });
        buf = '';
        out.push({ t: 'raw', s: c });
      } else buf += c;
    }
    if (buf) out.push({ t: 'lit', s: buf });
    return out;
  }

  /**
   * @param {string} value
   * @param {{zsh?:boolean, expand?:boolean}} opts
   * @returns {{text:string, diags:Array}}
   */
  CL.quote.posix = function (value, opts) {
    opts = opts || {};
    const s = String(value);
    const diags = [];
    if (s.includes('\0')) {
      diags.push(CL.diag('error', 'nul', 'A NUL byte cannot be passed as a command-line argument.'));
      return { text: sq(s.replace(/\0/g, '')), diags };
    }
    if (/[\r\n]/.test(s)) diags.push(CL.diag('warn', 'newline', 'Value contains a line break. It is quoted correctly, but check the paste lands as one command.'));
    let text;
    if (opts.expand && /^~|[*?]/.test(s)) {
      text = segments(s).map((g) => (g.t === 'raw' ? g.s : literal(g.s, opts.zsh))).join('');
      if (opts.zsh && /[*?]/.test(s)) diags.push(CL.diag('warn', 'zsh-nomatch', 'zsh refuses to run the whole command ("no matches found") if this glob matches nothing; bash passes it through. Append (N) to the glob, e.g. /tmp/*(N), if it may be empty.'));
    } else {
      text = literal(s, opts.zsh);
    }
    return { text, diags };
  };

  CL.quote._posixLiteral = literal;
})(typeof window !== 'undefined' ? window : globalThis);
