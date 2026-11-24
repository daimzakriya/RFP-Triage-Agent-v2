/**
 * Keeps the original uploaded PDFs in the browser (IndexedDB), so the evidence viewer can
 * show the real pages after a reload. Nothing leaves the browser. Every function fails soft:
 * if storage is unavailable (private mode, quota), the viewer falls back to page text.
 */
const DB = "rfp-triage-pdfs";
const STORE = "pdfs";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("no IndexedDB"));
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const r = fn(db.transaction(STORE, mode).objectStore(STORE));
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  } finally {
    db.close();
  }
}

export async function putPdf(docId: string, bytes: Uint8Array): Promise<boolean> {
  try {
    await tx("readwrite", (s) => s.put(new Blob([bytes as BlobPart], { type: "application/pdf" }), docId));
    return true;
  } catch {
    return false;
  }
}

export async function getPdf(docId: string): Promise<Uint8Array | null> {
  try {
    const blob = await tx<Blob | undefined>("readonly", (s) => s.get(docId));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

export async function deletePdf(docId: string): Promise<void> {
  try {
    await tx("readwrite", (s) => s.delete(docId));
  } catch {
    /* ignore */
  }
}
