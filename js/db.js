// db.js — IndexedDB 封装：书架 / 章节 / 段落，导出导入
const DB_NAME = 'storybook-reader';
const DB_VERSION = 2;

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains('books')) {
        db.createObjectStore('books', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('chapters')) {
        const s = db.createObjectStore('chapters', { keyPath: 'id', autoIncrement: true });
        s.createIndex('bookId', 'bookId');
      }
      if (!db.objectStoreNames.contains('paragraphs')) {
        const s = db.createObjectStore('paragraphs', { keyPath: 'id', autoIncrement: true });
        s.createIndex('chapterId', 'chapterId');
        s.createIndex('chapterId_number', ['chapterId', 'number']);
      }
      if (!db.objectStoreNames.contains('icons')) {
        db.createObjectStore('icons', { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    try { result = fn(s); } catch (err) { reject(err); return; }
    t.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('事务中止'));
  }));
}

function wrap(req) { return { __req: req }; }

// ---------------- 书 ----------------
export function addBook(title) {
  return tx('books', 'readwrite', (s) => {
    const r = s.add({ title, createdAt: Date.now() });
    return new Promise((res) => { r.onsuccess = () => res(r.result); });
  });
}

export function listBooks() {
  return tx('books', 'readonly', (s) => wrap(s.getAll()));
}
export function getBook(id) {
  return tx('books', 'readonly', (s) => wrap(s.get(id)));
}

export function deleteBook(id) {
  // 级联删除：章节 → 段落 → 书
  return openDB().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(['books', 'chapters', 'paragraphs'], 'readwrite');
    t.objectStore('books').delete(id);
    const chIdx = t.objectStore('chapters').index('bookId');
    const paIdx = t.objectStore('paragraphs').index('chapterId');
    const chapters = [];
    chIdx.openCursor().onsuccess = (e) => {
      const cur = e.target.result;
      if (cur) { chapters.push(cur.value); cur.continue(); }
      else {
        for (const ch of chapters) {
          paIdx.openCursor(IDBKeyRange.only(ch.id)).onsuccess = (ev) => {
            const c2 = ev.target.result;
            if (c2) { c2.delete(); c2.continue(); }
          };
          t.objectStore('chapters').delete(ch.id);
        }
      }
    };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  }));
}

// ---------------- 章节 ----------------
export function addChapter(bookId, title) {
  return tx('chapters', 'readwrite', (s) => {
    const r = s.add({ bookId, title, order: Date.now() });
    return new Promise((res) => { r.onsuccess = () => res(r.result); });
  });
}

export function listChapters(bookId) {
  return tx('chapters', 'readonly', (s) => wrap(s.index('bookId').getAll(IDBKeyRange.only(bookId))))
    .then((list) => list.sort((a, b) => a.order - b.order));
}
export function getChapter(id) {
  return tx('chapters', 'readonly', (s) => wrap(s.get(id)));
}
export function updateChapter(id, patch) {
  return tx('chapters', 'readwrite', (s) => new Promise((resolve, reject) => {
    const r = s.get(id);
    r.onsuccess = () => {
      if (!r.result) { resolve(null); return; }
      const rec = { ...r.result, ...patch };
      const w = s.put(rec);
      w.onsuccess = () => resolve(rec);
    };
    r.onerror = () => reject(r.error);
  }));
}
export function deleteChapter(id) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(['chapters', 'paragraphs'], 'readwrite');
    t.objectStore('chapters').delete(id);
    const idx = t.objectStore('paragraphs').index('chapterId');
    idx.openCursor(IDBKeyRange.only(id)).onsuccess = (e) => {
      const cur = e.target.result;
      if (cur) { cur.delete(); cur.continue(); }
    };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  }));
}

// ---------------- 段落 ----------------
// item: { type:'text', number, text, pending } 或 { type:'image', image:Blob, seq }
// 传入的 items 若无 seq，则按章节当前最大 seq 递增分配。
// 返回创建后的记录数组（含 id 与 seq）。
export function addParagraphs(chapterId, items) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction('paragraphs', 'readwrite');
    const s = t.objectStore('paragraphs');
    const idx = s.index('chapterId');
    const allReq = idx.getAll(IDBKeyRange.only(chapterId));
    const created = [];
    allReq.onsuccess = () => {
      let maxSeq = 0;
      for (const p of allReq.result) if (p.seq > maxSeq) maxSeq = p.seq;
      let seq = maxSeq;
      for (const it of items) {
        seq += 1;
        const rec = {
          chapterId,
          seq: it.seq != null ? it.seq : seq,
          type: it.type || 'text',
          number: it.number ?? null,
          text: it.text ?? '',
          pending: !!it.pending,
          image: it.image ?? null,
        };
        const r = s.add(rec);
        r.onsuccess = () => { rec.id = r.result; created.push(rec); };
      }
    };
    t.oncomplete = () => resolve(created);
    t.onerror = () => reject(t.error);
  }));
}

export function listParagraphs(chapterId) {
  return tx('paragraphs', 'readonly', (s) => wrap(s.index('chapterId').getAll(IDBKeyRange.only(chapterId))))
    .then((list) => list.sort((a, b) => a.seq - b.seq));
}

export function getParagraph(id) {
  return tx('paragraphs', 'readonly', (s) => wrap(s.get(id)));
}

export function updateParagraph(id, patch) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction('paragraphs', 'readwrite');
    const s = t.objectStore('paragraphs');
    const req = s.get(id);
    req.onsuccess = () => {
      const rec = req.result;
      if (!rec) return;
      Object.assign(rec, patch);
      s.put(rec);
    };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  }));
}

export function deleteParagraph(id) {
  return tx('paragraphs', 'readwrite', (s) => wrap(s.delete(id)));
}

// ---------------- 图标库 ----------------
export function addIcon(name, blob, mime) {
  return tx('icons', 'readwrite', (s) => {
    const r = s.add({ name, blob, mime: mime || 'image/png', createdAt: Date.now() });
    return new Promise((res) => { r.onsuccess = () => res(r.result); });
  });
}

export function listIcons() {
  return tx('icons', 'readonly', (s) => wrap(s.getAll()))
    .then((list) => list.sort((a, b) => a.createdAt - b.createdAt));
}

export function deleteIcon(id) {
  return tx('icons', 'readwrite', (s) => wrap(s.delete(id)));
}

export function getPendingParagraph(chapterId) {
  return tx('paragraphs', 'readonly', (s) => wrap(s.index('chapterId').getAll(IDBKeyRange.only(chapterId))))
    .then((list) => {
      const pending = list.filter((p) => p.pending).sort((a, b) => a.seq - b.seq);
      return pending.length ? pending[pending.length - 1] : null;
    });
}

export function closePending(chapterId) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction('paragraphs', 'readwrite');
    const idx = t.objectStore('paragraphs').index('chapterId');
    idx.openCursor(IDBKeyRange.only(chapterId)).onsuccess = (e) => {
      const cur = e.target.result;
      if (cur) {
        if (cur.value.pending) { cur.value.pending = false; cur.update(cur.value); }
        cur.continue();
      }
    };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  }));
}

// ---------------- 导出 / 导入 ----------------
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl) {
  return (fetch(dataUrl)).then((r) => r.blob());
}

export async function exportData() {
  const [books, chapters, paragraphs] = await Promise.all([
    tx('books', 'readonly', (s) => wrap(s.getAll())),
    tx('chapters', 'readonly', (s) => wrap(s.getAll())),
    tx('paragraphs', 'readonly', (s) => wrap(s.getAll())),
  ]);
  const outParas = [];
  for (const p of paragraphs) {
    const copy = { ...p };
    if (copy.image instanceof Blob) copy.image = await blobToDataUrl(copy.image);
    outParas.push(copy);
  }
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    books, chapters, paragraphs: outParas,
  };
}

export async function importData(data) {
  if (!data || data.version !== 1 || !Array.isArray(data.books)) {
    throw new Error('文件格式不正确');
  }
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const t = db.transaction(['books', 'chapters', 'paragraphs'], 'readwrite');
    for (const name of ['books', 'chapters', 'paragraphs']) t.objectStore(name).clear();
    for (const b of data.books) t.objectStore('books').put({ id: b.id, title: b.title, createdAt: b.createdAt });
    for (const c of data.chapters) t.objectStore('chapters').put({ ...c });
    for (const p of data.paragraphs) {
      const copy = { ...p };
      if (typeof copy.image === 'string' && copy.image.startsWith('data:')) {
        // dataUrl → Blob 在事务外做不了，先放 dataUrl，导入后统一转换
        copy.image = null;
        copy._imageDataUrl = p.image;
      }
      t.objectStore('paragraphs').put(copy);
    }
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
  // 第二步：把 dataUrl 图片转回 Blob 逐条更新
  const paras = await tx('paragraphs', 'readonly', (s) => wrap(s.getAll()));
  for (const p of paras) {
    if (p._imageDataUrl) {
      const blob = await dataUrlToBlob(p._imageDataUrl);
      await updateParagraph(p.id, { image: blob, _imageDataUrl: undefined });
    }
  }
}
