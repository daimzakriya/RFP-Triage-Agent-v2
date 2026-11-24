"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DeskItem } from "@/lib/desk";
import {
  CATEGORY_INFO,
  collectFindings,
  evidenceKey,
  locateQuote,
  pageRuns,
  type Finding,
  type HighlightCategory,
  type Located,
  type TextRun,
} from "@/lib/evidence-map";
import { getPdf } from "@/lib/pdf-store";
import type { VerifiedEvidence } from "@/lib/schema";
import { SourceViewer } from "./SourceViewer";

/* One open pdf.js document per stored PDF, reused across clicks. */
type PdfDoc = Awaited<ReturnType<typeof import("unpdf")["getDocumentProxy"]>>;
const docs = new Map<string, Promise<PdfDoc | null>>();
function loadDoc(docId: string): Promise<PdfDoc | null> {
  if (!docs.has(docId)) {
    docs.set(
      docId,
      (async () => {
        const bytes = await getPdf(docId);
        if (!bytes) return null;
        const { getDocumentProxy } = await import("unpdf");
        return getDocumentProxy(bytes);
      })().catch(() => null),
    );
  }
  return docs.get(docId)!;
}
/* Text positions for pages whose findings were not located at upload time (older items). */
const runCache = new Map<string, TextRun[]>();

interface Mark {
  finding: Finding;
  loc: Located;
}

const CONFIDENCE_TEXT = {
  exact: "Exact match in the PDF",
  fuzzy: "Close match only: read the highlighted passage to confirm",
  none: "Precise highlighting unavailable",
} as const;

export function Legend({ compact = false }: { compact?: boolean }) {
  return (
    <ul className={`hl-legend ${compact ? "compact" : ""}`} aria-label="Highlight colours">
      {(Object.keys(CATEGORY_INFO) as HighlightCategory[]).map((c) => (
        <li key={c}>
          <span className="sw" style={{ background: CATEGORY_INFO[c].color }} aria-hidden="true" />
          {CATEGORY_INFO[c].label}
        </li>
      ))}
    </ul>
  );
}

/**
 * Opens the original PDF at the cited page, with every located finding on that page
 * highlighted in its category colour, and the clicked one focused.
 */
export function PdfEvidenceViewer({ evidence, item, onClose }: { evidence: VerifiedEvidence | null; item: DeskItem | null; onClose: () => void }) {
  const dlg = useRef<HTMLDialogElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [doc, setDoc] = useState<PdfDoc | null | "loading">("loading");
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [active, setActive] = useState(0);
  const [rendering, setRendering] = useState(false);
  const [clickedLoc, setClickedLoc] = useState<Located | null>(null);

  const findings = useMemo(() => (item ? collectFindings(item.report) : []), [item]);
  const clicked: Finding | null = useMemo(() => {
    if (!evidence) return null;
    return findings.find((f) => f.key === evidenceKey(evidence)) ?? { key: evidenceKey(evidence), label: "Source", category: "other", evidence };
  }, [evidence, findings]);

  /* open / close the dialog */
  useEffect(() => {
    const d = dlg.current;
    if (!d) return;
    if (evidence && item?.docId && !d.open) d.showModal();
    if ((!evidence || !item?.docId) && d.open) d.close();
  }, [evidence, item]);

  /* load the document once per stored PDF */
  useEffect(() => {
    if (!evidence || !item?.docId) return;
    let live = true;
    setDoc("loading");
    loadDoc(item.docId).then((d) => live && setDoc(d));
    setPage(evidence.page);
    setZoom(1);
    return () => {
      live = false;
    };
  }, [evidence, item?.docId]);

  /* locate every finding on the current page (cached locations first) */
  const locate = useCallback(
    async (f: Finding): Promise<Located> => {
      const cached = item?.locations?.[f.key];
      if (cached) return cached;
      if (!doc || doc === "loading") return { page: f.evidence.page, quote: f.evidence.quote, boxes: [], confidence: "none", score: 0, reason: "The PDF isn't loaded." };
      const ck = `${item?.docId}:${f.evidence.page}`;
      let runs = runCache.get(ck);
      if (!runs) {
        runs = await pageRuns(await doc.getPage(f.evidence.page));
        runCache.set(ck, runs);
      }
      return locateQuote(runs, f.evidence.page, f.evidence.quote);
    },
    [doc, item],
  );

  useEffect(() => {
    if (!clicked || !doc || doc === "loading") return;
    let live = true;
    (async () => {
      const onPage = findings.filter((f) => f.evidence.page === page);
      const list: Mark[] = [];
      const seenBoxes = new Set<string>();
      for (const f of onPage) {
        const loc = await locate(f);
        if (loc.confidence === "none") continue;
        const k = JSON.stringify(loc.boxes);
        if (seenBoxes.has(k)) continue; // same passage cited by two findings: show once
        seenBoxes.add(k);
        list.push({ finding: f, loc });
      }
      list.sort((a, b) => a.loc.boxes[0].y - b.loc.boxes[0].y || a.loc.boxes[0].x - b.loc.boxes[0].x);
      const cl = await locate(clicked);
      if (!live) return;
      setClickedLoc(cl);
      setMarks(list);
      const i = list.findIndex((m) => m.finding.key === clicked.key || JSON.stringify(m.loc.boxes) === JSON.stringify(cl.boxes));
      setActive(page === clicked.evidence.page && i >= 0 ? i : list.length ? 0 : -1);
    })();
    return () => {
      live = false;
    };
  }, [clicked, doc, page, findings, locate, item]);


  /* render the page; highlights are % positioned, so they follow any zoom */
  useEffect(() => {
    if (!doc || doc === "loading" || !canvas.current || !scroller.current) return;
    let task: { cancel: () => void; promise: Promise<unknown> } | null = null;
    let live = true;
    (async () => {
      setRendering(true);
      const p = await doc.getPage(Math.min(Math.max(page, 1), doc.numPages));
      const base = p.getViewport({ scale: 1 });
      const fit = (scroller.current!.clientWidth - 32) / base.width;
      const vp = p.getViewport({ scale: fit * zoom });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const c = canvas.current!;
      c.width = Math.floor(vp.width * dpr);
      c.height = Math.floor(vp.height * dpr);
      const ctx = c.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!live) return;
      setSize({ w: vp.width, h: vp.height });
      task = p.render({ canvasContext: ctx, viewport: vp, canvas: c } as never) as unknown as typeof task;
      await task!.promise.catch(() => {});
      if (live) setRendering(false);
    })();
    return () => {
      live = false;
      task?.cancel();
    };
  }, [doc, page, zoom]);

  /* bring the active highlight into view */
  useEffect(() => {
    if (active < 0 || rendering) return;
    const el = scroller.current?.querySelector<HTMLElement>(`[data-mark="${active}"]`);
    el?.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
  }, [active, rendering, marks, zoom]);

  if (!evidence || !item) return null;
  // Older reports, or browsers without storage: fall back to the page-text viewer.
  if (!item.docId || doc === null) return <SourceViewer evidence={evidence} pages={item.pages} onClose={onClose} />;

  const total = doc === "loading" ? 0 : doc.numPages;
  const current = marks[active];
  const onClickedPage = page === evidence.page;

  return (
    <dialog ref={dlg} className="viewer pdfv" onClose={onClose} aria-labelledby="pdfv-title">
      <header>
        <div style={{ minWidth: 0 }}>
          <strong id="pdfv-title">{item.report.document.fileName}</strong>
          <div className="small muted">Original PDF · evidence highlighted</div>
        </div>
        <div className="pdfv-tools">
          <button className="btn btn-sm" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>‹</button>
          <span className="days">p. {page} / {total || "…"}</span>
          <button className="btn btn-sm" aria-label="Next page" disabled={!total || page >= total} onClick={() => setPage((p) => p + 1)}>›</button>
          <span className="sep" />
          <button className="btn btn-sm" aria-label="Zoom out" disabled={zoom <= 0.5} onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))}>−</button>
          <button className="btn btn-sm btn-ghost" aria-label="Fit to width" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
          <button className="btn btn-sm" aria-label="Zoom in" disabled={zoom >= 3} onClick={() => setZoom((z) => Math.min(3, +(z + 0.25).toFixed(2)))}>+</button>
          <span className="sep" />
          <button className="btn btn-sm" onClick={onClose} autoFocus>Close</button>
        </div>
      </header>

      <div className="pdfv-info">
        {clicked && onClickedPage && (
          <div className="pdfv-finding">
            <span className="sw" style={{ background: CATEGORY_INFO[clicked.category].color }} aria-hidden="true" />
            <span className="pdfv-cat">{CATEGORY_INFO[clicked.category].label}</span>
            <span className="pdfv-label">{clicked.label}</span>
            {clickedLoc && (
              <span className={`chip ${clickedLoc.confidence === "exact" ? "chip-bid" : clickedLoc.confidence === "fuzzy" ? "chip-warn" : "chip-nobid"}`}>
                {CONFIDENCE_TEXT[clickedLoc.confidence]}
                {clickedLoc.confidence === "fuzzy" ? ` · ${Math.round(clickedLoc.score * 100)}% of words` : ""}
              </span>
            )}
          </div>
        )}
        {clickedLoc?.confidence === "none" && onClickedPage && (
          <div className="alert alert-warn small" role="status">
            <span aria-hidden="true">⚠</span>
            <span>
              The exact passage couldn&apos;t be pinned on this page, so nothing is highlighted for it. {clickedLoc.reason} Showing page {evidence.page}.
              The cited quote: “{evidence.quote}”
            </span>
          </div>
        )}
        <div className="pdfv-nav">
          <span className="small muted">
            {marks.length ? `Highlight ${active + 1} of ${marks.length} on this page` : "No highlighted findings on this page"}
          </span>
          <button className="btn btn-sm" aria-label="Previous highlight" disabled={marks.length < 2} onClick={() => setActive((a) => (a - 1 + marks.length) % marks.length)}>▲</button>
          <button className="btn btn-sm" aria-label="Next highlight" disabled={marks.length < 2} onClick={() => setActive((a) => (a + 1) % marks.length)}>▼</button>
          {current && !(clicked && current.finding.key === clicked.key) && (
            <span className="small pdfv-current">
              <span className="sw" style={{ background: CATEGORY_INFO[current.finding.category].color }} aria-hidden="true" /> {current.finding.label}
            </span>
          )}
        </div>
      </div>

      <div className="pdfv-scroll" ref={scroller}>
        {doc === "loading" && <p className="muted small" style={{ padding: 16 }}>Opening the PDF…</p>}
        <div className="pdfv-page" style={size ? { width: size.w, height: size.h } : { display: doc === "loading" ? "none" : undefined }}>
          <canvas ref={canvas} style={size ? { width: size.w, height: size.h } : undefined} aria-label={`Page ${page} of the PDF`} />
          {!rendering &&
            marks.map((m, i) =>
              m.loc.boxes.map((b, j) => (
                <button
                  key={`${i}-${j}`}
                  type="button"
                  data-mark={j === 0 ? i : undefined}
                  className={`hl ${i === active ? "active" : ""}`}
                  title={`${CATEGORY_INFO[m.finding.category].label}: ${m.finding.label}`}
                  aria-label={j === 0 ? `Highlight: ${m.finding.label}` : undefined}
                  tabIndex={j === 0 ? 0 : -1}
                  onClick={() => setActive(i)}
                  style={{
                    left: `${b.x * 100}%`,
                    top: `${b.y * 100}%`,
                    width: `${b.w * 100}%`,
                    height: `${b.h * 100}%`,
                    ["--hl" as string]: CATEGORY_INFO[m.finding.category].color,
                  }}
                />
              )),
            )}
        </div>
      </div>

      <footer className="pdfv-foot">
        <Legend compact />
      </footer>
    </dialog>
  );
}
