/* L3 — "What this regex does": tokenize a pattern for the dialect in use, explain each token in
 * plain words, and flag the mistakes that make an IOC line quietly miss (an unescaped dot, a
 * findstr | taken literally, a \d that POSIX ERE does not support). A small sample-line tester
 * runs where JavaScript's engine matches the target engine, and refuses where it does not. */
(function (root) {
  'use strict';
  const CL = (root.CL = root.CL || {});

  // which features each dialect has
  const DIALECTS = {
    ere: { name: 'POSIX extended (grep -E, awk, egrep)', alt: true, group: true, quant: true, brace: true, backslashClasses: false, posixClass: true, backref: false },
    bre: { name: 'POSIX basic (grep, sed)', alt: false, group: false, quant: 'partial', brace: false, backslashClasses: false, posixClass: true, backref: true },
    pcre: { name: 'Perl (grep -P, PCRE)', alt: true, group: true, quant: true, brace: true, backslashClasses: true, posixClass: true, backref: true },
    dotnet: { name: '.NET (Select-String, -match)', alt: true, group: true, quant: true, brace: true, backslashClasses: true, posixClass: false, backref: true },
    findstr: { name: 'findstr /r', alt: false, group: false, quant: 'star', brace: false, backslashClasses: false, posixClass: false, backref: false, special: true },
  };

  const CLASS = { d: 'any digit 0-9', D: 'any non-digit', w: 'a word character (letter, digit or _)', W: 'a non-word character', s: 'any whitespace', S: 'any non-whitespace', b: 'a word boundary', B: 'a non-boundary', A: 'start of input', Z: 'end of input', n: 'a newline', t: 'a tab', r: 'a carriage return' };

  /**
   * @returns {{ dialect, dialectName, tokens:[{text,kind,explain}], notes:[], warnings:[], errors:[] }}
   */
  CL.explainRegex = function (pattern, dialect) {
    dialect = dialect || 'ere';
    const D = DIALECTS[dialect] || DIALECTS.ere;
    const s = String(pattern == null ? '' : pattern);
    const tokens = [];
    const warnings = [];
    const notes = [];
    const errors = [];
    const push = (text, kind, explain) => tokens.push({ text, kind, explain });

    // findstr has its own tiny language; explain it directly
    if (dialect === 'findstr') {
      if (/\|/.test(s)) warnings.push('findstr has no | alternation: a | matches a literal pipe character. Use several /c: strings for "any of".');
      if (/[+?(){}]/.test(s)) warnings.push('findstr /r has no + ? ( ) { }: those match literally, not as quantifiers or groups.');
    }
    if (D.alt === false && dialect !== 'findstr' && /(^|[^\\])\|/.test(s)) notes.push(`${D.name}: | is a literal pipe unless written as \\|.`);

    let i = 0;
    const n = s.length;
    let groupDepth = 0;
    while (i < n) {
      const c = s[i];
      if (c === '\\') {
        const nx = s[i + 1];
        if (nx === undefined) { push('\\', 'error', 'a trailing backslash with nothing to escape'); errors.push('The pattern ends with a lone backslash.'); i += 1; continue; }
        if (/[dDwWsSbBAZ]/.test(nx)) {
          if (!D.backslashClasses && /[dDwWsS]/.test(nx)) warnings.push(`\\${nx} is a Perl/.NET shorthand and does NOT work in ${D.name}. Use ${nx.toLowerCase() === 'd' ? '[0-9] or [[:digit:]]' : nx.toLowerCase() === 'w' ? '[[:alnum:]_]' : '[[:space:]]'} instead.`);
          push('\\' + nx, 'class', CLASS[nx] || ('escape \\' + nx));
          i += 2; continue;
        }
        push('\\' + nx, 'literal', `a literal "${nx}"`);
        i += 2; continue;
      }
      if (c === '.') { push('.', 'meta', 'any single character (this is where IOC patterns go wrong: a literal dot must be \\.)'); i++; continue; }
      if (c === '^') { push('^', 'anchor', i === 0 ? 'start of the line' : 'start of the line (or a negation inside [ ])'); i++; continue; }
      if (c === '$') { push('$', 'anchor', 'end of the line'); i++; continue; }
      if (c === '[') {
        let j = i + 1, neg = false;
        if (s[j] === '^') { neg = true; j++; }
        if (s[j] === ']') j++;
        while (j < n && s[j] !== ']') { if (s[j] === '[' && s[j + 1] === ':') { const e = s.indexOf(':]', j); if (e > -1) j = e + 1; } j++; }
        const body = s.slice(i, j + 1);
        const posix = /\[:(\w+):\]/.exec(body);
        if (posix && !D.posixClass) warnings.push(`[[:${posix[1]}:]] is a POSIX class and does NOT work in ${D.name}. Use \\${posix[1] === 'digit' ? 'd' : posix[1] === 'space' ? 's' : 'w'} or an explicit range.`);
        push(body, 'class', (neg ? 'any character NOT in this set' : 'any one character in this set') + (posix ? ` (POSIX class :${posix[1]}:)` : ''));
        i = j + 1; continue;
      }
      if (c === '(') {
        let label = 'start of a capturing group';
        if (s[i + 1] === '?') {
          if (s[i + 2] === ':') { label = 'start of a non-capturing group'; push('(?:', 'group', label); i += 3; groupDepth++; continue; }
          if (s[i + 2] === '=') { label = 'start of a lookahead (must be followed by this)'; push('(?=', 'group', label); i += 3; groupDepth++; continue; }
          if (s[i + 2] === '!') { label = 'start of a negative lookahead (must NOT be followed by this)'; push('(?!', 'group', label); i += 3; groupDepth++; continue; }
        }
        if (!D.group) { push('(', 'literal', `a literal "(" in ${D.name} (groups need \\( \\) here)`); i++; continue; }
        push('(', 'group', label); i++; groupDepth++; continue;
      }
      if (c === ')') { if (!D.group) { push(')', 'literal', 'a literal ")"'); i++; continue; } push(')', 'group', 'end of the group'); i++; groupDepth = Math.max(0, groupDepth - 1); continue; }
      if (c === '|') { if (!D.alt) { push('|', 'literal', 'a literal pipe'); i++; continue; } push('|', 'meta', 'OR: either the left or the right side can match'); i++; continue; }
      if (c === '*') { push('*', 'quant', 'the previous item, zero or more times'); i++; continue; }
      if (c === '+') { if (D.quant === 'star' || D.quant === 'partial') { push('+', 'literal', `a literal "+" in ${D.name}`); i++; continue; } push('+', 'quant', 'the previous item, one or more times'); i++; continue; }
      if (c === '?') { if (D.quant === 'star' || D.quant === 'partial') { push('?', 'literal', `a literal "?" in ${D.name}`); i++; continue; } push('?', 'quant', 'the previous item, zero or one time (optional)'); i++; continue; }
      if (c === '{') {
        const m = /^\{(\d+)(,(\d*)?)?\}/.exec(s.slice(i));
        if (m && D.brace) { const lo = m[1], hi = m[3]; push(m[0], 'quant', m[2] === undefined ? `exactly ${lo} times` : hi ? `between ${lo} and ${hi} times` : `${lo} or more times`); i += m[0].length; continue; }
        push('{', 'literal', 'a literal "{"'); i++; continue;
      }
      // whitespace and ordinary characters
      push(c, 'literal', c === ' ' ? 'a literal space' : `a literal "${c}"`); i++;
    }
    if (groupDepth > 0) errors.push('A group is opened with ( but never closed with ).');

    // IOC-style heuristics: unescaped dots in something that looks like an IP, domain or hash
    if (/\d+\.\d+\.\d+\.\d+/.test(s) && /[^\\]\./.test('.' + s)) {
      const unescaped = (s.match(/(^|[^\\])\./g) || []).length;
      if (unescaped) warnings.push(`This looks like an IP or domain with ${unescaped} unescaped dot${unescaped > 1 ? 's' : ''}. In a regex, "." matches any character, so 198.51.100.23 also matches 198x51y100z23. Escape each dot as \\. or use fixed-string matching.`);
    }

    const uniq = (a) => [...new Set(a)];
    return { dialect, dialectName: D.name, tokens, notes: uniq(notes), warnings: uniq(warnings), errors: uniq(errors) };
  };

  /**
   * Try sample lines against the pattern. Runs only where JavaScript's engine agrees with the
   * target engine; otherwise it refuses so it never shows a false match.
   * @returns {{ ran:boolean, reason?:string, results?:[{line, match:boolean, text?:string}] }}
   */
  CL.testRegex = function (pattern, dialect, lines, flags) {
    const D = DIALECTS[dialect] || DIALECTS.ere;
    if (dialect === 'findstr' || dialect === 'bre') return { ran: false, reason: `${D.name} differs from the browser's regex engine, so a live test could mislead. The explanation above still applies.` };
    let js = String(pattern);
    // POSIX classes → JS equivalents (only for a reliable test)
    const posixMap = { 'alpha': 'A-Za-z', 'digit': '0-9', 'alnum': 'A-Za-z0-9', 'space': '\\s', 'upper': 'A-Z', 'lower': 'a-z', 'xdigit': '0-9A-Fa-f', 'punct': '!-/:-@\\[-`{-~', 'blank': ' \\t' };
    if (/\[:\w+:\]/.test(js)) {
      if (!D.posixClass) return { ran: false, reason: 'This pattern uses a POSIX class that this dialect does not support, so the pattern itself is wrong — fix it first.' };
      js = js.replace(/\[:(\w+):\]/g, (m, c) => posixMap[c] !== undefined ? posixMap[c] : m);
    }
    let re;
    try { re = new RegExp(js, (flags || '')); } catch (e) { return { ran: false, reason: 'The browser could not compile this pattern (' + e.message + '), so it cannot be tested here.' }; }
    const results = (lines || []).map((line) => {
      const m = re.exec(line);
      return { line, match: !!m, text: m ? m[0] : '' };
    });
    return { ran: true, results };
  };

  CL.REGEX_DIALECTS = DIALECTS;
})(typeof window !== 'undefined' ? window : globalThis);
