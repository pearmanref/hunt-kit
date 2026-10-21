/* L0 — cmd.exe quoting, interactive console context.
 *
 * Two independent parsers read every argument, so quoting is done in two layers:
 *   1. argv layer: the program splits its own command line (MSVCRT / CommandLineToArgvW rules):
 *      "…" groups spaces; inside quotes \" is a literal quote; backslashes are literal except
 *      directly before a quote, where they must be doubled.
 *   2. cmd layer: cmd.exe reads the line first. It toggles a quote state on EVERY " (it knows
 *      nothing about \"), and outside that state & | < > ^ ( ) must be escaped with ^.
 *      %NAME% expands even inside quotes. Interactive cmd has no %% escape, so a % that could
 *      start a variable is emitted outside quotes as %^ — cmd then looks up a variable whose
 *      name starts with ^, finds none, keeps the text, and strips the caret afterwards.
 *
 * The walk in step 3 simulates cmd's quote state to place carets and to detect the one case
 * no encoding can fix: an odd number of " in the value, which leaves cmd in the wrong quote
 * state for everything after it (an | would no longer be a pipe). That case is refused.
 */
(function (root) {
  'use strict';
  const CL = (root.CL = root.CL || {});
  CL.quote = CL.quote || {};

  const CMD_SPECIAL = /[&|<>^()]/;
  const NEEDS_QUOTE = /[\s"&|<>^()]/;
  const SAFE_CHAR = /[A-Za-z0-9_.\-:\\\/@#$+,;=~{}\[\]'`*?]/;
  const PCT = '\u0001'; // internal marker for an emitted %^

  /** argv layer: quote one run for MSVCRT parsing. */
  function argvQuote(s) {
    if (s !== '' && !NEEDS_QUOTE.test(s)) return s;
    let out = '"';
    let bs = 0;
    for (const c of s) {
      if (c === '\\') { bs++; continue; }
      if (c === '"') { out += '\\'.repeat(bs * 2 + 1) + '"'; bs = 0; continue; }
      out += '\\'.repeat(bs) + c;
      bs = 0;
    }
    out += '\\'.repeat(bs * 2) + '"';
    return out;
  }

  /** Split the value at every % that is followed by a char that could start a variable name. */
  function split(s) {
    const pieces = [];
    let buf = '';
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '%' && i + 1 < s.length && SAFE_CHAR.test(s[i + 1])) {
        pieces.push({ run: buf });
        // the char after %^ must be outside quotes so the caret escapes it, and it is a safe char
        pieces.push({ pct: s[i + 1] });
        buf = '';
        i++;
      } else buf += s[i];
    }
    pieces.push({ run: buf });
    return pieces;
  }

  /**
   * @param {string} value
   * @param {{prefix?:string}} opts  prefix is emitted bare before the value (e.g. /c: for findstr)
   */
  CL.quote.cmd = function (value, opts) {
    opts = opts || {};
    const s = String(value);
    const diags = [];
    if (s.includes('\0') || /[\r\n]/.test(s)) {
      diags.push(CL.diag('error', 'cmd-newline', 'cmd cannot pass a line break or NUL inside an argument.'));
    }
    // expand intent: %VAR% is meant to expand (path library entries like %APPDATA%\…)
    const pieces = opts.expand ? [{ run: s }] : split(s);
    const hasPct = pieces.some((p) => p.pct);
    let staged = opts.prefix || '';
    if (!hasPct) {
      staged += argvQuote(s);
    } else {
      for (const p of pieces) {
        if (p.pct !== undefined) staged += '%' + PCT + p.pct;
        else if (p.run !== '') staged += argvQuote(p.run);
      }
    }
    // cmd layer: walk with cmd's quote state
    let out = '';
    let inQ = false;
    for (const c of staged) {
      if (c === PCT) {
        if (inQ) diags.push(CL.diag('error', 'cmd-pct-quoted', 'A % in this value would sit inside cmd quotes, where it cannot be protected from variable expansion.'));
        out += '^';
        continue;
      }
      if (c === '"') { inQ = !inQ; out += c; continue; }
      if (!inQ && CMD_SPECIAL.test(c)) { out += '^' + c; continue; }
      out += c;
    }
    if (inQ) {
      diags.push(CL.diag('error', 'cmd-quote-parity',
        'This value has an odd number of double quotes. cmd tracks quotes on every ", so the rest of the line would be read as quoted and a following | or > would stop working. Use a pattern file (findstr /g:) or PowerShell for this value.'));
    }
    // a lone % that is not followed by a variable-name char cannot expand, but tell the analyst why it was left alone
    if (/%(?![A-Za-z0-9_.\-:\\\/@#$+,;=~{}\[\]'`*?])/.test(s) && /%.*%/.test(s) && !hasPct) {
      diags.push(CL.diag('info', 'cmd-pct', '% characters were left as typed; none of them can start a variable reference.'));
    }
    if (hasPct) diags.push(CL.diag('info', 'cmd-pct-caret', '%^ is the interactive-console escape for a literal %. It does not work inside a .bat file (use %% there).'));
    return { text: out, diags };
  };

  CL.quote._cmdArgv = argvQuote;
})(typeof window !== 'undefined' ? window : globalThis);
