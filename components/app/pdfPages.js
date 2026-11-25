/**
 * Renders pages of the original PDF (kept in this browser's IndexedDB) to images for the
 * evidence viewer, and finds quote positions for older reports that were stored without them.
 */
import { useEffect, useState } from "react";
import { getPdf } from "@/lib/pdf-store";
import { locateQuote, pageRuns } from "@/lib/evidence-map";

const docs = new Map();
function loadDoc(docId) {
  if (!docs.has(docId)) {
    docs.set(docId, (async () => {
      const bytes = await getPdf(docId);
      if (!bytes) return null;
      const { getDocumentProxy } = await import("unpdf");
      return getDocumentProxy(bytes);
    })().catch(() => null));
  }
  return docs.get(docId);
}

const images = new Map();
function pageImage(docId, page, scale) {
  const key = `${docId}:${page}:${scale}`;
  if (!images.has(key)) {
    images.set(key, (async () => {
      const doc = await loadDoc(docId);
      if (!doc || page < 1 || page > doc.numPages) return null;
      const p = await doc.getPage(page);
      const vp = p.getViewport({ scale });
      const c = document.createElement("canvas");
      c.width = Math.ceil(vp.width);
      c.height = Math.ceil(vp.height);
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, c.width, c.height);
      await p.render({ canvasContext: ctx, viewport: vp, canvas: c }).promise;
      return c.toDataURL("image/jpeg", scale < 0.5 ? 0.7 : 0.9);
    })().catch(() => null));
  }
  return images.get(key);
}

/** Image of one page: undefined while rendering, null when the PDF isn't available. */
export function usePageImage(docId, page, scale) {
  const [src, setSrc] = useState(undefined);
  useEffect(() => {
    let live = true;
    setSrc(undefined);
    if (!docId) { setSrc(null); return; }
    pageImage(docId, page, scale).then((s) => live && setSrc(s));
    return () => { live = false; };
  }, [docId, page, scale]);
  return src;
}

/** Fills in highlight boxes for findings on a page that were stored without positions. */
const located = new Set();
export async function locateMissing(r, page, items) {
  const todo = items.filter((f) => f.ev.page === page && !f.ev.boxes?.length && f.ev.check !== "unverified");
  const key = `${r.id}:${page}`;
  if (!r.docId || !todo.length || located.has(key)) return false;
  located.add(key);
  const doc = await loadDoc(r.docId);
  if (!doc) return false;
  const runs = await pageRuns(await doc.getPage(page));
  let changed = false;
  for (const f of todo) {
    const loc = locateQuote(runs, page, f.ev.quote);
    if (loc.boxes.length) { f.ev.boxes = loc.boxes; f.ev.conf = loc.confidence; changed = true; }
  }
  return changed;
}
