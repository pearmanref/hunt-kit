/* L2 — storage. IndexedDB for everything that grows (history, recipes, IOC sets, user paths
 * and tools); localStorage only for small settings and the current draft. Every call is wrapped:
 * if storage is blocked (private window, policy), the app keeps working in memory and shows a
 * red "not saving" pill, so the analyst knows to export the workspace before closing. */
(function (root) {
  'use strict';
  const CL = (root.CL = root.CL || {});

  const DB_NAME = 'command-lens';
  const DB_VERSION = 1;
  const STORES = ['history', 'recipes', 'iocSets', 'userPaths', 'userTools', 'userShells'];
  const LS_PREFIX = 'command-lens:';

  const mem = Object.fromEntries(STORES.map((s) => [s, new Map()]));
  let db = null;
  let mode = 'memory';

  function req(r) {
    return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  }

  const store = {
    get mode() { return mode; },

    async open() {
      try {
        if (!root.indexedDB) throw new Error('IndexedDB unavailable');
        const r = root.indexedDB.open(DB_NAME, DB_VERSION);
        r.onupgradeneeded = () => {
          const d = r.result;
          for (const s of STORES) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' });
        };
        db = await req(r);
        mode = 'indexeddb';
      } catch (e) {
        db = null;
        mode = 'memory';
      }
      return mode;
    },

    async all(name) {
      if (!db) return [...mem[name].values()];
      try { return await req(db.transaction(name).objectStore(name).getAll()); }
      catch (e) { return [...mem[name].values()]; }
    },

    async put(name, obj) {
      mem[name].set(obj.id, obj);
      if (!db) return obj;
      try { await req(db.transaction(name, 'readwrite').objectStore(name).put(JSON.parse(JSON.stringify(obj)))); }
      catch (e) { mode = 'memory'; }
      return obj;
    },

    async del(name, id) {
      mem[name].delete(id);
      if (!db) return;
      try { await req(db.transaction(name, 'readwrite').objectStore(name).delete(id)); } catch (e) { mode = 'memory'; }
    },

    async clear(name) {
      mem[name].clear();
      if (!db) return;
      try { await req(db.transaction(name, 'readwrite').objectStore(name).clear()); } catch (e) { mode = 'memory'; }
    },

    async clearAll() {
      for (const s of STORES) await store.clear(s);
      try {
        for (const k of Object.keys(root.localStorage || {})) if (k.startsWith(LS_PREFIX)) root.localStorage.removeItem(k);
      } catch (e) { /* storage blocked: nothing persisted anyway */ }
    },

    getSetting(key, dflt) {
      try {
        const v = root.localStorage.getItem(LS_PREFIX + key);
        return v === null ? dflt : JSON.parse(v);
      } catch (e) { return dflt; }
    },

    setSetting(key, value) {
      try { root.localStorage.setItem(LS_PREFIX + key, JSON.stringify(value)); return true; } catch (e) { return false; }
    },

    STORES,
  };

  CL.store = store;
})(typeof window !== 'undefined' ? window : globalThis);
