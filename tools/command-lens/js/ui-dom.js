/* L4 — small DOM helpers shared by every view. No rules or formatting decisions live here. */
(function (root) {
  'use strict';
  const CL = (root.CL = root.CL || {});
  const ui = (CL.ui = CL.ui || {});

  /** h('div.cls#id', {attr}, ...children) */
  ui.h = function (spec, attrs, ...kids) {
    const m = /^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i.exec(spec) || [];
    const el = document.createElement(m[1] || 'div');
    for (const part of (m[2] || '').match(/[.#][\w-]+/g) || []) {
      if (part[0] === '.') el.classList.add(part.slice(1));
      else el.id = part.slice(1);
    }
    if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') throw new Error('no innerHTML');
      else if (k === 'value') el.value = v;
      else if (k in el && k !== 'list' && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    const add = (k) => {
      if (k === null || k === undefined || k === false) return;
      if (Array.isArray(k)) k.forEach(add);
      else el.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
    };
    kids.forEach(add);
    return el;
  };
  ui.$ = (sel, root2) => (root2 || document).querySelector(sel);
  ui.clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

  let toastTimer;
  ui.toast = function (msg, ms) {
    const t = ui.$('#toast');
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('on'), ms || 2200);
  };

  /** Modal with arbitrary body; resolves with the clicked action's value (or null on Esc). */
  ui.modal = function (title, body, actions) {
    return new Promise((resolve) => {
      const m = ui.$('#modal');
      const b = ui.clear(ui.$('#modalBody'));
      const done = (v) => { m.hidden = true; document.removeEventListener('keydown', onKey, true); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } };
      b.append(ui.h('h3', { text: title }), body);
      const row = ui.h('div.actions');
      for (const a of actions || [{ label: 'Close', value: null }]) {
        row.append(ui.h('button.btn' + (a.primary ? '.primary' : '') + (a.danger ? '.danger' : ''), { text: a.label, onclick: () => done(typeof a.value === 'function' ? a.value() : a.value) }));
      }
      b.append(row);
      m.hidden = false;
      document.addEventListener('keydown', onKey, true);
      const f = b.querySelector('input, textarea, select, button.primary');
      if (f) setTimeout(() => f.focus(), 0);
      m.onclick = (e) => { if (e.target === m) done(null); };
    });
  };

  ui.copyText = async function (text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      // file:// in some browsers, or a denied permission: fall back to a hidden textarea
      const ta = ui.$('#clipFallback');
      ta.value = text;
      ta.select();
      try { return document.execCommand('copy'); } catch (e2) { return false; } finally { ta.value = ''; }
    }
  };

  ui.download = function (name, text, type) {
    const a = ui.h('a', { download: name, href: URL.createObjectURL(new Blob([text], { type: type || 'application/json' })) });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  };

  ui.pickFiles = function (accept, multiple) {
    return new Promise((resolve) => {
      const i = ui.h('input', { type: 'file', accept: accept || '', multiple: !!multiple });
      i.addEventListener('change', () => resolve([...i.files]));
      i.click();
    });
  };
  ui.readFile = (f) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsText(f); });

  /** Popup menu anchored under an element. items: [{label, onclick} | {sep:true} | {hdr:'text'}] */
  ui.menu = function (anchor, items) {
    ui.closeMenus();
    const m = ui.h('div.menu', { role: 'menu' });
    for (const it of items) {
      if (it.sep) m.append(ui.h('div.sep'));
      else if (it.hdr) m.append(ui.h('div.hdr', { text: it.hdr }));
      else m.append(ui.h('button', { role: 'menuitem', text: it.label, title: it.title || '', onclick: () => { ui.closeMenus(); it.onclick(); } }));
    }
    document.body.append(m);
    const r = anchor.getBoundingClientRect();
    m.style.left = Math.min(r.left + window.scrollX, window.scrollX + document.documentElement.clientWidth - m.offsetWidth - 8) + 'px';
    m.style.top = r.bottom + window.scrollY + 2 + 'px';
    const first = m.querySelector('button');
    if (first) first.focus();
    m.addEventListener('keydown', (e) => {
      const bs = [...m.querySelectorAll('button')];
      const i = bs.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); (bs[i + 1] || bs[0]).focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); (bs[i - 1] || bs[bs.length - 1]).focus(); }
      if (e.key === 'Escape') { ui.closeMenus(); anchor.focus(); }
    });
    setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
    function outside(e) { if (!m.contains(e.target)) { ui.closeMenus(); } }
    m._outside = outside;
    return m;
  };
  ui.closeMenus = function () {
    for (const m of document.querySelectorAll('.menu')) { document.removeEventListener('mousedown', m._outside, true); m.remove(); }
  };

  ui.fmtTime = (iso) => {
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
})(typeof window !== 'undefined' ? window : globalThis);
