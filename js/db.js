/* Almacenamiento local en IndexedDB. Nada sale del dispositivo.
   Stores:
     movs  -> movimientos { id, tipo, fecha, monto(centavos), desc, cat, medio, ambito, fijoId, creado, editado }
     kv    -> configuración { key, value } (fuentes, categorías, medios, fijos, presupuestos, inflación, etc.) */
(function () {
  'use strict';

  const DB_NAME = 'cuentas-lqdemp';
  const DB_VERSION = 1;
  let dbp = null;
  let memory = null; // respaldo en memoria si IndexedDB no está disponible

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) { reject(new Error('sin indexedDB')); return; }
      let req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('movs')) {
          const s = db.createObjectStore('movs', { keyPath: 'id' });
          s.createIndex('fecha', 'fecha');
        }
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('base bloqueada'));
    }).catch(err => {
      console.warn('IndexedDB no disponible, uso memoria:', err);
      memory = { movs: new Map(), kv: new Map() };
      return null;
    });
    return dbp;
  }

  function tx(store, mode, fn) {
    return open().then(db => {
      if (!db) return fn(null);
      return new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        let result;
        Promise.resolve(fn(s)).then(r => { result = r; });
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('transacción abortada'));
      });
    });
  }

  function reqP(r) {
    return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  }

  const DB = {
    isMemory() { return !!memory; },

    async allMovs() {
      await open();
      if (memory) return [...memory.movs.values()];
      return tx('movs', 'readonly', s => reqP(s.getAll()));
    },
    async putMov(m) {
      await open();
      if (memory) { memory.movs.set(m.id, m); return m; }
      await tx('movs', 'readwrite', s => { s.put(m); });
      return m;
    },
    async putMovs(list) {
      await open();
      if (memory) { list.forEach(m => memory.movs.set(m.id, m)); return; }
      await tx('movs', 'readwrite', s => { list.forEach(m => s.put(m)); });
    },
    async deleteMov(id) {
      await open();
      if (memory) { memory.movs.delete(id); return; }
      await tx('movs', 'readwrite', s => { s.delete(id); });
    },

    async get(key, fallback) {
      await open();
      if (memory) return memory.kv.has(key) ? memory.kv.get(key) : fallback;
      const row = await tx('kv', 'readonly', s => reqP(s.get(key)));
      return row ? row.value : fallback;
    },
    async set(key, value) {
      await open();
      if (memory) { memory.kv.set(key, value); return; }
      await tx('kv', 'readwrite', s => { s.put({ key, value }); });
    },
    async allKV() {
      await open();
      if (memory) return [...memory.kv.entries()].map(([key, value]) => ({ key, value }));
      return tx('kv', 'readonly', s => reqP(s.getAll()));
    },

    /** Reemplaza TODO (para importar una copia) */
    async replaceAll(movs, kvRows) {
      await open();
      if (memory) {
        memory.movs = new Map(movs.map(m => [m.id, m]));
        memory.kv = new Map(kvRows.map(r => [r.key, r.value]));
        return;
      }
      const db = await open();
      await new Promise((resolve, reject) => {
        const t = db.transaction(['movs', 'kv'], 'readwrite');
        const sm = t.objectStore('movs');
        const sk = t.objectStore('kv');
        sm.clear(); sk.clear();
        movs.forEach(m => sm.put(m));
        kvRows.forEach(r => sk.put(r));
        t.oncomplete = resolve;
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('transacción abortada'));
      });
    },

    /** Pide al navegador que no borre los datos si falta espacio */
    async persist() {
      try {
        if (navigator.storage && navigator.storage.persist) {
          if (await navigator.storage.persisted()) return true;
          return await navigator.storage.persist();
        }
      } catch (e) { /* sin soporte */ }
      return false;
    }
  };

  window.DB = DB;
})();
