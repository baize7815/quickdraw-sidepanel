(() => {
  'use strict';

  const core = globalThis.QDCore;

  class QuickdrawStorage {
    constructor() {
      this.dbPromise = null;
      this.objectUrls = new Map();
      this.objectUrlPromises = new Map();
    }

    async withLock(name, task) {
      if (navigator?.locks?.request) return navigator.locks.request(`quickdraw:${name}`, task);
      return task();
    }

    async get(keys, area = 'local') {
      const store = globalThis.chrome?.storage?.[area];
      if (store) return store.get(keys);
      const out = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        const raw = localStorage.getItem(`${area}:${key}`) ?? localStorage.getItem(key);
        if (raw !== null) {
          try { out[key] = JSON.parse(raw); } catch { out[key] = raw; }
        }
      }
      return out;
    }

    async set(values, area = 'local') {
      const store = globalThis.chrome?.storage?.[area];
      if (store) return store.set(values);
      for (const [key, value] of Object.entries(values)) localStorage.setItem(`${area}:${key}`, JSON.stringify(value));
    }

    async remove(keys, area = 'local') {
      const store = globalThis.chrome?.storage?.[area];
      if (store) return store.remove(keys);
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        localStorage.removeItem(`${area}:${key}`);
        localStorage.removeItem(key);
      }
    }

    openDatabase() {
      if (this.dbPromise) return this.dbPromise;
      this.dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open('quickdraw-v3', 2);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('versions')) {
            const versions = db.createObjectStore('versions', { keyPath: 'id', autoIncrement: true });
            versions.createIndex('fileId', 'fileId');
            versions.createIndex('createdAt', 'createdAt');
          }
          if (!db.objectStoreNames.contains('handles')) db.createObjectStore('handles', { keyPath: 'key' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('IndexedDB unavailable'));
      });
      return this.dbPromise;
    }

    async transaction(storeName, mode, operation) {
      const db = await this.openDatabase();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        let result;
        try { result = operation(store); } catch (error) { reject(error); return; }
        tx.oncomplete = () => resolve(result?.result ?? result);
        tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
        tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
      });
    }

    async putAsset(blob, meta = {}) {
      if (!(blob instanceof Blob)) throw new TypeError('Asset must be a Blob');
      const id = core.newId('a');
      await this.transaction('assets', 'readwrite', store => store.put({ id, blob, type: blob.type || 'application/octet-stream', createdAt: Date.now(), ...meta }));
      return id;
    }

    async getAsset(id) {
      if (!id) return null;
      const db = await this.openDatabase();
      return new Promise((resolve, reject) => {
        const request = db.transaction('assets', 'readonly').objectStore('assets').get(id);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
      });
    }

    async deleteAsset(id) {
      if (!id) return;
      this.objectUrlPromises.delete(id);
      const url = this.objectUrls.get(id);
      if (url) URL.revokeObjectURL(url);
      this.objectUrls.delete(id);
      await this.transaction('assets', 'readwrite', store => store.delete(id));
    }

    async clearDrawingData() {
      const db = await this.openDatabase();
      const names = ['assets','versions'].filter(name=>db.objectStoreNames.contains(name));
      if (names.length) {
        await new Promise((resolve, reject) => {
          const tx = db.transaction(names, 'readwrite');
          for (const name of names) tx.objectStore(name).clear();
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error || new Error('Unable to clear IndexedDB'));
          tx.onabort = () => reject(tx.error || new Error('IndexedDB clear aborted'));
        });
      }
      this.objectUrlPromises.clear();
      for (const url of this.objectUrls.values()) URL.revokeObjectURL(url);
      this.objectUrls.clear();
      const drawingKey=key=>key==='quickdraw_v2_files'||key.startsWith('quickdraw_v2_file:')||key==='quickdraw_elements'||key==='pending_image'||key.startsWith('quickdraw_pending_capture:')||key.startsWith('quickdraw_pdf_export:');
      for (const areaName of ['local', 'session']) {
        const area = globalThis.chrome?.storage?.[areaName];
        if(area){const values=await area.get(null),keys=Object.keys(values).filter(drawingKey);if(keys.length)await area.remove(keys);}
      }
      if(!globalThis.chrome?.storage?.local){
        for(const key of Object.keys(localStorage))if(drawingKey(key.replace(/^(local|session):/,'')))localStorage.removeItem(key);
      }
      if(!globalThis.chrome?.storage?.session&&globalThis.sessionStorage){
        for(const key of Object.keys(sessionStorage))if(drawingKey(key))sessionStorage.removeItem(key);
      }
    }

    async putHandle(key, handle) {
      if (!key || !handle) throw new TypeError('A key and handle are required');
      await this.transaction('handles', 'readwrite', store => store.put({ key, handle, updatedAt: Date.now() }));
    }

    async getHandle(key) {
      if (!key) return null;
      const db = await this.openDatabase();
      return new Promise((resolve, reject) => {
        const request = db.transaction('handles', 'readonly').objectStore('handles').get(key);
        request.onsuccess = () => resolve(request.result?.handle || null);
        request.onerror = () => reject(request.error);
      });
    }

    async deleteHandle(key) {
      if (!key) return;
      await this.transaction('handles', 'readwrite', store => store.delete(key));
    }

    async getAssetUrl(id) {
      if (!id) return '';
      if (this.objectUrls.has(id)) return this.objectUrls.get(id);
      const pending = this.objectUrlPromises.get(id);
      if (pending) return pending;
      const request = (async () => {
        const record = await this.getAsset(id);
        if (!record?.blob) return '';
        const url = URL.createObjectURL(record.blob);
        // A delete/release may have invalidated this request while the record
        // was loading. Revoke the late URL instead of putting it back in the
        // cache with no owner.
        if (this.objectUrlPromises.get(id) !== request) {
          URL.revokeObjectURL(url);
          return '';
        }
        this.objectUrls.set(id, url);
        return url;
      })();
      this.objectUrlPromises.set(id, request);
      request.then(
        () => { if (this.objectUrlPromises.get(id) === request) this.objectUrlPromises.delete(id); },
        () => { if (this.objectUrlPromises.get(id) === request) this.objectUrlPromises.delete(id); }
      );
      return request;
    }

    releaseObjectUrlsExcept(ids) {
      const keep = new Set(ids || []);
      for (const id of this.objectUrlPromises.keys()) {
        if (!keep.has(id)) this.objectUrlPromises.delete(id);
      }
      for (const [id, url] of this.objectUrls) {
        if (keep.has(id)) continue;
        URL.revokeObjectURL(url);
        this.objectUrls.delete(id);
      }
    }

    async dataUrlToBlob(dataUrl) {
      const response = await fetch(dataUrl);
      return response.blob();
    }

    blobToDataUrl(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error('Unable to read asset'));
        reader.readAsDataURL(blob);
      });
    }

    async exportAssets(ids) {
      const assets = [];
      for (const id of new Set(ids || [])) {
        const record = await this.getAsset(id);
        if (record?.blob) assets.push({ id, type: record.type, name: record.name || '', data: await this.blobToDataUrl(record.blob) });
      }
      return assets;
    }

    async importAsset(asset) {
      if (!asset?.data?.startsWith('data:image/') || asset.data.length > 35_000_000) throw new Error('Invalid project asset');
      const blob = await this.dataUrlToBlob(asset.data);
      if (!blob.type.startsWith('image/') || blob.size > 25 * 1024 * 1024) throw new Error('Invalid project asset');
      return this.putAsset(blob, { name: asset.name || '', importedFrom: asset.id || '' });
    }

    async saveVersion(fileId, document, name, force = false) {
      if (!fileId || !document) return;
      const versions = await this.listVersions(fileId);
      const latest = versions[0];
      const hash = core.hashString(JSON.stringify(document.elements || []));
      if (latest?.hash === hash) return;
      const now = Date.now();
      if (!force && latest && now - latest.createdAt < 60_000) {
        await this.transaction('versions', 'readwrite', store => store.put({ ...latest, document: core.clone(document), name, hash, createdAt: now }));
        return;
      }
      await this.transaction('versions', 'readwrite', store => store.add({ fileId, document: core.clone(document), name, hash, createdAt: now }));
      const refreshed = await this.listVersions(fileId);
      for (const old of refreshed.slice(30)) await this.transaction('versions', 'readwrite', store => store.delete(old.id));
    }

    async listVersions(fileId) {
      const db = await this.openDatabase();
      return new Promise((resolve, reject) => {
        const request = db.transaction('versions', 'readonly').objectStore('versions').index('fileId').getAll(fileId);
        request.onsuccess = () => resolve((request.result || []).sort((a, b) => b.createdAt - a.createdAt));
        request.onerror = () => reject(request.error);
      });
    }

    async deleteVersions(fileId) {
      const versions = await this.listVersions(fileId);
      for (const version of versions) await this.transaction('versions', 'readwrite', store => store.delete(version.id));
    }

    async cleanupAssets(referencedIds) {
      const keep = new Set(referencedIds || []);
      const db = await this.openDatabase();
      const all = await new Promise((resolve, reject) => {
        const request = db.transaction('assets', 'readonly').objectStore('assets').getAllKeys();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      });
      for (const id of all) {
        if (keep.has(id)) continue;
        this.objectUrlPromises.delete(id);
        const url = this.objectUrls.get(id);
        if (url) URL.revokeObjectURL(url);
        this.objectUrls.delete(id);
        await this.transaction('assets', 'readwrite', store => store.delete(id));
      }
    }
  }

  globalThis.QuickdrawStorage = QuickdrawStorage;
})();
