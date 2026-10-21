/* L1 — paste-to-extract: refang, find typed IOCs, resolve overlaps.
 *
 * Extractors run in priority order. Each match is blanked out of the working text before the
 * next extractor runs, so a URL's path is not also reported as a file path and an e-mail's
 * domain is not reported twice. URL hosts are then added back explicitly as domain/IP IOCs.
 * Nothing is saved here: the UI shows the list for review first.
 */
(function (root) {
  'use strict';
  const CL = (root.CL = root.CL || {});

  CL.IOC_TYPES = [
    { id: 'ipv4', label: 'IPv4' }, { id: 'ipv6', label: 'IPv6' }, { id: 'domain', label: 'Domain' }, { id: 'url', label: 'URL' },
    { id: 'md5', label: 'MD5' }, { id: 'sha1', label: 'SHA1' }, { id: 'sha256', label: 'SHA256' },
    { id: 'path', label: 'File path' }, { id: 'filename', label: 'File name' }, { id: 'process', label: 'Process' },
    { id: 'regkey', label: 'Registry key' }, { id: 'user', label: 'User' }, { id: 'sid', label: 'SID' }, { id: 'email', label: 'E-mail' },
  ];

  /** Undo common defanging: hxxp, [.], (.), {.}, [dot], [:], [@], [at]. */
  CL.refang = function (s) {
    return String(s)
      .replace(/\bh[x*]{2}p(s?)(?=\[?:)/gi, 'http$1')
      .replace(/\bfxp(?=\[?:)/gi, 'ftp')
      .replace(/\[:\/\/\]/g, '://')
      .replace(/\[:\]/g, ':')
      .replace(/[\[({]\s*(?:\.|dot)\s*[\])}]/gi, '.')
      .replace(/[\[({]\s*(?:@|at)\s*[\])}]/gi, '@');
  };

  const FILE_EXT = 'exe|dll|sys|scr|com|cpl|ocx|ps1|psm1|psd1|bat|cmd|vbs|vbe|js|jse|wsf|hta|lnk|msi|msp|jar|py|sh|elf|so|bin|iso|img|vhd|vhdx|zip|rar|7z|gz|tar|cab|doc|docx|docm|xls|xlsx|xlsm|ppt|pptx|pdf|rtf|txt|log|csv|tmp|dat|ini|cfg|conf|xml|json|php|asp|aspx|jsp|evtx';
  const PROC_EXT = /\.(exe|scr|com)$/i;
  // common generic TLDs; any two-letter label is accepted as a ccTLD
  const GTLD = new Set(('com net org info biz edu gov mil int arpa io co app dev xyz top online site club shop store tech cloud live life world space website press ' +
    'news blog digital email network services solutions systems support host link click download icu buzz win bid loan work vip pro mobi name asia tel ' +
    'travel jobs aero coop museum cat xxx onion local test example invalid localhost lan corp internal home zip mov').split(' '));

  const RX = [
    { type: 'url', re: /\b(?:https?|ftp):\/\/[^\s"'<>\]\[{}|\\^`]+/gi, tidy: (v) => v.replace(/[.,;:!?)\]}'"]+$/, '') },
    { type: 'email', re: /\b[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,63}\b/g, tidy: (v) => v.toLowerCase() },
    { type: 'regkey', re: /\b(?:HKLM|HKCU|HKCR|HKU|HKCC|HKEY_LOCAL_MACHINE|HKEY_CURRENT_USER|HKEY_CLASSES_ROOT|HKEY_USERS|HKEY_CURRENT_CONFIG):?\\(?:[^\\\s"'<>|]+(?: [^\\\s"'<>|]+)*\\)*[^\\\s"'<>|,;]+/g },
    { type: 'path', re: /(?:\b[A-Za-z]:|\\\\[A-Za-z0-9._-]+)\\(?:[^\\\/:*?"<>|\r\n\t]+\\)*[^\\\/:*?"<>|\r\n\t\s,;]*/g, tidy: (v) => v.replace(/[.)\]]+$/, '') },
    { type: 'path', re: /(?<![\w.:\/-])\/(?:etc|tmp|var|home|usr|opt|root|dev|bin|sbin|lib|lib64|proc|srv|run|mnt|media|boot)(?:\/[\w.@+-]+)+\/?/g, tidy: (v) => v.replace(/\.$/, '') },
    { type: 'sha256', re: /(?<![A-Fa-f0-9])[A-Fa-f0-9]{64}(?![A-Fa-f0-9])/g, tidy: (v) => v.toLowerCase() },
    { type: 'sha1', re: /(?<![A-Fa-f0-9])[A-Fa-f0-9]{40}(?![A-Fa-f0-9])/g, tidy: (v) => v.toLowerCase() },
    { type: 'md5', re: /(?<![A-Fa-f0-9])[A-Fa-f0-9]{32}(?![A-Fa-f0-9])/g, tidy: (v) => v.toLowerCase() },
    { type: 'sid', re: /\bS-1-\d{1,2}(?:-\d{1,10}){1,14}\b/g },
    { type: 'ipv6', re: /(?<![A-Fa-f0-9:])(?:(?:[A-Fa-f0-9]{1,4}:){7}[A-Fa-f0-9]{1,4}|(?:[A-Fa-f0-9]{1,4}:){1,7}:|(?:[A-Fa-f0-9]{1,4}:){1,6}:[A-Fa-f0-9]{1,4}|(?:[A-Fa-f0-9]{1,4}:){1,5}(?::[A-Fa-f0-9]{1,4}){1,2}|(?:[A-Fa-f0-9]{1,4}:){1,4}(?::[A-Fa-f0-9]{1,4}){1,3}|(?:[A-Fa-f0-9]{1,4}:){1,3}(?::[A-Fa-f0-9]{1,4}){1,4}|(?:[A-Fa-f0-9]{1,4}:){1,2}(?::[A-Fa-f0-9]{1,4}){1,5}|[A-Fa-f0-9]{1,4}:(?::[A-Fa-f0-9]{1,4}){1,6}|:(?::[A-Fa-f0-9]{1,4}){1,7})(?![A-Fa-f0-9:])/g,
      accept: (v) => /::/.test(v) ? v.length > 2 || v === '::1' : (v.match(/:/g) || []).length === 7, tidy: (v) => v.toLowerCase() },
    { type: 'ipv4', re: /(?<![\d.])(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}(?![\d.]*\d)/g },
    { type: 'user', re: /\b[A-Za-z][\w.-]{0,14}\\[A-Za-z][\w.$-]{0,19}\b/g },
    { type: 'filename', re: new RegExp('(?<![\\w.\\\\/-])[\\w$@~][\\w.$@~-]{0,120}\\.(?:' + FILE_EXT + ')\\b', 'gi') },
    { type: 'domain', re: /\b(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}\b/g, tidy: (v) => v.toLowerCase(),
      accept: (v) => {
        const tld = v.split('.').pop().toLowerCase();
        if (new RegExp('^(' + FILE_EXT + ')$', 'i').test(tld)) return false;
        return tld.length === 2 ? true : GTLD.has(tld);
      } },
  ];

  /**
   * @param {string} text  any pasted text (report, e-mail, CSV)
   * @returns {Array<{type, value, refanged:boolean}>}  de-duplicated, in order of first appearance
   */
  CL.extractIocs = function (text) {
    const original = String(text || '');
    let work = CL.refang(original);
    const refangedAny = work !== original;
    const found = [];
    const blank = (s, a, b) => s.slice(0, a) + ' '.repeat(b - a) + s.slice(b);
    for (const ex of RX) {
      ex.re.lastIndex = 0;
      const hits = [];
      let m;
      while ((m = ex.re.exec(work))) {
        let v = m[0];
        if (ex.tidy) v = ex.tidy(v);
        if (!v || (ex.accept && !ex.accept(v))) continue;
        hits.push({ type: ex.type, value: v, start: m.index, end: m.index + m[0].length });
      }
      for (const h of hits) work = blank(work, h.start, h.end);
      found.push(...hits);
    }
    // URL hosts become their own domain / IP IOC
    for (const f of found.filter((x) => x.type === 'url')) {
      try {
        const host = new URL(f.value).hostname.replace(/^\[|\]$/g, '');
        const type = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? 'ipv4' : host.includes(':') ? 'ipv6' : 'domain';
        found.push({ type, value: host.toLowerCase(), start: f.start + 0.5, end: f.end, fromUrl: true });
      } catch (e) { /* not a parseable URL: keep the URL only */ }
    }
    // executables are processes by default; the review table lets the analyst change it
    for (const f of found) if (f.type === 'filename' && PROC_EXT.test(f.value)) f.type = 'process';
    found.sort((a, b) => a.start - b.start);
    const seen = new Set();
    const out = [];
    for (const f of found) {
      const k = f.type + '\u0000' + f.value;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ type: f.type, value: f.value, refanged: refangedAny, fromUrl: !!f.fromUrl });
    }
    return out;
  };

  /** Merge confirmed IOCs into a set, de-duplicating by type+value. Returns number added. */
  CL.addToSet = function (set, iocs) {
    const have = new Set((set.items || []).map((x) => x.type + '\u0000' + x.value));
    let n = 0;
    set.items = set.items || [];
    for (const i of iocs) {
      const k = i.type + '\u0000' + i.value;
      if (have.has(k)) continue;
      have.add(k);
      set.items.push({ type: i.type, value: i.value, added: CL.isoNow(), src: i.src || 'paste' });
      n++;
    }
    return n;
  };

  CL.newIocSet = (name) => ({ id: CL.uid('set'), name: name || 'New set', note: '', created: CL.isoNow(), items: [] });

  /** CSV import/export: type,value per line (header optional). */
  CL.iocSetToCsv = (set) => 'type,value\n' + (set.items || []).map((i) => `${i.type},"${String(i.value).replace(/"/g, '""')}"`).join('\n') + '\n';
  CL.iocCsvParse = function (csv) {
    const out = [];
    const types = new Set(CL.IOC_TYPES.map((t) => t.id));
    for (const line of String(csv).split(/\r?\n/)) {
      const m = /^\s*([a-z0-9]+)\s*,\s*(?:"((?:[^"]|"")*)"|(.*))\s*$/i.exec(line);
      if (!m || !types.has(m[1].toLowerCase())) continue;
      out.push({ type: m[1].toLowerCase(), value: (m[2] !== undefined ? m[2].replace(/""/g, '"') : m[3]).trim() });
    }
    return out;
  };
})(typeof window !== 'undefined' ? window : globalThis);
