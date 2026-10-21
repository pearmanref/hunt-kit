/* L0 — PowerShell quoting (5.1 and 7 share these rules).
 * Literal intent → single-quoted string; the only escape inside is doubling the quote char.
 * PowerShell treats the typographic quotes ‘ ’ ‚ ‛ as single quotes too (and “ ” „ as double
 * quotes), so a value pasted from a report containing ’ must have it doubled as well.
 * Bare words are kept only when they cannot be re-interpreted in argument mode:
 *   - a leading digit can parse as a number (007 → 7, 1kb → 1024, 0x10 → 16)
 *   - a leading - (or en/em dash) is read as a parameter name
 *   - $ @ ( ) { } ; , ` # ' " < > | & and spaces all mean something
 * Wildcards are not the shell's business in PowerShell: cmdlets expand them, which is why
 * the assembler switches -Path to -LiteralPath for literal paths containing [ ] * ?.
 */
(function (root) {
  'use strict';
  const CL = (root.CL = root.CL || {});
  CL.quote = CL.quote || {};

  const BARE = /^[A-Za-z_\\\/][A-Za-z0-9_.\\\/:]*$/;
  const SQ = /['‘’‚‛]/g;
  const DQ_ESC = /[`"“”„$]/g;

  function sq(s) {
    return "'" + s.replace(SQ, (c) => c + c) + "'";
  }

  CL.quote.pwsh = function (value) {
    const s = String(value);
    const diags = [];
    if (s.includes('\0')) {
      diags.push(CL.diag('error', 'nul', 'A NUL byte cannot be passed as an argument.'));
    }
    if (/[\r\n]/.test(s)) diags.push(CL.diag('warn', 'newline', 'Value contains a line break. It is quoted correctly, but check the paste lands as one command.'));
    // ':' stays bare only as a drive or provider qualifier (C:\…, HKLM:\…); elsewhere quote it
    const colonOk = !s.includes(':') || /^[A-Za-z]+:\\[^:]*$/.test(s);
    if (s !== '' && BARE.test(s) && colonOk) return { text: s, diags };
    return { text: sq(s), diags };
  };

  /** Always-quoted single-quoted literal: used inside expressions (hashtables, arrays). */
  CL.quote.pwshString = (s) => sq(String(s));

  /** Double-quoted string with every expansion character escaped by backtick.
   *  Used when the content must sit inside "…" (e.g. a WQL filter that itself contains '…'). */
  CL.quote.pwshDouble = (s) => '"' + String(s).replace(DQ_ESC, (c) => '`' + c) + '"';
})(typeof window !== 'undefined' ? window : globalThis);
