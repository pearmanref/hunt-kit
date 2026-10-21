/* L0 — namespace bootstrap and small helpers. No knowledge of tools, shells or the DOM.
 * Every file is a classic script that attaches to window.CL (browser) or globalThis.CL (Node),
 * because ES modules and fetch() are blocked under file://. */
(function (root) {
  'use strict';
  const CL = (root.CL = root.CL || {});

  CL.VERSION = '0.4.0';

  /** Compare dotted versions: '5.1' < '7' < '7.4'. Missing parts are 0. */
  CL.cmpVersion = function (a, b) {
    const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d < 0 ? -1 : 1;
    }
    return 0;
  };

  /** true if `version` satisfies an item's minVersion / maxVersion. Absent version = no limit. */
  CL.versionOk = function (item, version) {
    if (!item || !version) return true;
    if (item.minVersion && CL.cmpVersion(version, item.minVersion) < 0) return false;
    if (item.maxVersion && CL.cmpVersion(version, item.maxVersion) > 0) return false;
    return true;
  };

  CL.clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));

  let seq = 0;
  CL.uid = function (prefix) {
    seq = (seq + 1) % 1e6;
    return (prefix || 'id') + '-' + Date.now().toString(36) + '-' + seq.toString(36) + Math.random().toString(36).slice(2, 6);
  };

  CL.escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** Replace {name} placeholders. Unknown names are left as-is so a template bug is visible. */
  CL.fill = function (tpl, vars) {
    return String(tpl).replace(/\{([a-zA-Z0-9_]+)\}/g, (m, k) => (vars[k] === undefined ? m : vars[k]));
  };

  CL.isoNow = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  /** Diagnostic record shared by every layer. level: 'error' blocks copy, 'warn' informs, 'info' explains. */
  CL.diag = function (level, code, msg, ref) {
    return { level, code, msg, ref: ref || null };
  };
})(typeof window !== 'undefined' ? window : globalThis);
