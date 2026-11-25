import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { ArrowLeft, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Check, AlertTriangle, PanelLeft, Loader2 } from "lucide-react";
import { CATS, cn, findings, pageFindings } from "../lib";
import { Button, Tip } from "../ui";
import { usePageImage, locateMissing } from "../pdfPages";

export default function Viewer({ r, ctx, onBack }) {
  const list = findings(r);
  const ev = ctx.evidence;
  const f = ev.i != null ? list[ev.i] : null;
  const page = ev.page ?? f?.ev.page ?? 1;
  const [zoom, setZoom] = useState(1);
  const [thumbs, setThumbs] = useState(true);
  const scroller = useRef(null);
  const onPage = useMemo(() => {
    const seen = new Set();
    return pageFindings(r, page).filter((x) => { const k = JSON.stringify(x.ev.boxes); if (seen.has(k)) return false; seen.add(k); return true; });
  }, [r, page]);
  const [, bump] = useState(0);
  useEffect(() => { let live = true; locateMissing(r, page, list).then((c) => live && c && bump((n) => n + 1)); return () => { live = false; }; }, [r, page, list]);
  const activeKey = f ? JSON.stringify(f.ev.boxes) : null;
  const src = usePageImage(r.docId, page, 2);

  const goFinding = (i) => ctx.setEvidence({ id: r.id, i: (i + list.length) % list.length });
  const goPage = (p) => { const fs = pageFindings(r, p); ctx.setEvidence(fs.length ? { id: r.id, i: fs[0].i } : { id: r.id, page: p }); };

  useEffect(() => {
    const k = (e) => {
      if (/INPUT|TEXTAREA/.test(document.activeElement?.tagName)) return;
      if (e.key === "Escape") onBack();
      if (e.key === "ArrowRight" && f) { e.preventDefault(); goFinding(f.i + 1); }
      if (e.key === "ArrowLeft" && f) { e.preventDefault(); goFinding(f.i - 1); }
    };
    addEventListener("keydown", k); return () => removeEventListener("keydown", k);
  });
  // scroll the active highlight into view
  useEffect(() => {
    const t = setTimeout(() => {
      const el = scroller.current?.querySelector(".hl.on");
      if (el && scroller.current) scroller.current.scrollTo({ top: el.offsetTop + el.offsetParent.offsetTop - scroller.current.clientHeight / 3, behavior: "smooth" });
      else scroller.current?.scrollTo({ top: 0 });
    }, 60);
    return () => clearTimeout(t);
  }, [ev, zoom]);
  const rail = useRef(null);
  useEffect(() => { const el = document.getElementById(`th-${page}`); const c = rail.current; if (el && c) { const top = el.offsetTop - c.offsetTop; if (top < c.scrollTop || top + el.offsetHeight > c.scrollTop + c.clientHeight) c.scrollTo({ top: top - 12, behavior: "smooth" }); } }, [page, thumbs]);

  const cat = f ? CATS[f.cat] : null;
  return (
    <>
      <div className="fixed inset-0 z-30 bg-ink/30 xl:hidden" onClick={onBack} />
      <motion.aside initial={{ x: 40, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 40, opacity: 0 }} transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        className="fixed xl:static inset-y-0 right-0 z-40 w-full sm:w-[min(640px,100vw)] xl:w-auto h-full flex flex-col bg-subtle border-l border-line shadow-pop xl:shadow-none" aria-label="Source PDF">
        {/* header */}
        <div className="bg-surface border-b border-line px-4 py-3 grid gap-2.5">
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={onBack}><ArrowLeft size={14} />Back to report</Button>
            <div className="flex-1" />
            <Tip content="Previous finding (←)"><Button size="iconSm" disabled={!f} onClick={() => goFinding(f.i - 1)} aria-label="Previous finding"><ChevronLeft size={15} /></Button></Tip>
            <span className="tnum text-[12px] text-ink-2 min-w-[54px] text-center">{f ? `${f.i + 1} / ${list.length}` : `– / ${list.length}`}</span>
            <Tip content="Next finding (→)"><Button size="iconSm" disabled={!f} onClick={() => goFinding(f.i + 1)} aria-label="Next finding"><ChevronRight size={15} /></Button></Tip>
          </div>
          {f ? (
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px]">
                <span className="inline-flex items-center gap-1.5 text-ink-2"><span className="w-2.5 h-2.5 rounded-[3px]" style={{ background: cat.color }} />{cat.label}</span>
                <span className="tnum text-ink-3">Page {page} of {r.pageCount}</span>
                <span className={cn("inline-flex items-center gap-1 font-medium", f.ev.check === "unverified" ? "text-nobid" : f.ev.conf === "exact" ? "text-bid" : "text-warn")}>{f.ev.conf === "exact" && f.ev.check !== "unverified" ? <Check size={13} strokeWidth={2.6} /> : <AlertTriangle size={12} />}{f.ev.check === "unverified" ? "Not found in the document" : f.ev.conf === "exact" ? "Exact match" : f.ev.boxes.length ? "Close match" : "Position not found"}</span>
              </div>
              <div className="mt-1 font-medium text-[14px] leading-snug line-clamp-2">{f.label}</div>
              <blockquote className="mt-1.5 text-[12.5px] text-ink-2 leading-[1.6] line-clamp-3"><span className="marked" style={{ "--hc": f.cat === "other" ? "var(--hilite)" : cat.color }}>{f.ev.quote.replace(/\s+/g, " ")}</span></blockquote>
            </div>
          ) : <div className="text-[13px] text-ink-2">Page {page} of {r.pageCount}. No findings were taken from this page.</div>}
        </div>

        {/* body */}
        <div className="flex-1 min-h-0 flex">
          {thumbs && r.docId && (
            <div ref={rail} className="hidden sm:flex relative w-[86px] shrink-0 flex-col gap-2 overflow-y-auto scroll-thin p-2.5 border-r border-line bg-surface" aria-label="Pages">
              {Array.from({ length: r.pageCount }, (_, k) => {
                const p = k + 1;
                const cats = [...new Set(findings(r).filter((x) => x.ev.page === p).map((x) => x.cat))];
                return (
                  <button key={p} id={`th-${p}`} onClick={() => goPage(p)} aria-label={`Page ${p}`} aria-current={p === page ? "page" : undefined} className="group text-center cursor-pointer">
                    <div className={cn("relative rounded-[3px] overflow-hidden border-2 transition-colors", p === page ? "border-accent" : "border-transparent group-hover:border-line-2")}>
                      <Thumb docId={r.docId} page={p} />
                      {cats.length > 0 && <div className="absolute right-0.5 top-0.5 flex flex-col gap-0.5">{cats.map((c) => <span key={c} className="w-1.5 h-2.5 rounded-[1px]" style={{ background: CATS[c].color }} />)}</div>}
                    </div>
                    <div className={cn("tnum text-[10.5px] mt-0.5", p === page ? "text-accent font-semibold" : "text-ink-3")}>{p}</div>
                  </button>
                );
              })}
            </div>
          )}
          <div className="flex-1 min-w-0 flex flex-col">
            <div className="flex items-center gap-1.5 px-3 h-10 border-b border-line bg-surface/70">
              <Tip content="Toggle page thumbnails"><Button variant="ghost" size="iconSm" className="hidden sm:inline-flex" onClick={() => setThumbs((v) => !v)} aria-label="Toggle page thumbnails"><PanelLeft size={15} /></Button></Tip>
              <Button variant="ghost" size="iconSm" disabled={page <= 1} onClick={() => goPage(page - 1)} aria-label="Previous page"><ChevronLeft size={15} /></Button>
              <span className="text-[12px] text-ink-2 tnum">p. {page} / {r.pageCount}</span>
              <Button variant="ghost" size="iconSm" disabled={page >= r.pageCount} onClick={() => goPage(page + 1)} aria-label="Next page"><ChevronRight size={15} /></Button>
              <div className="flex-1" />
              <Button variant="ghost" size="iconSm" disabled={zoom <= 0.6} onClick={() => setZoom((z) => +(z - 0.2).toFixed(1))} aria-label="Zoom out"><ZoomOut size={15} /></Button>
              <button onClick={() => setZoom(1)} className="tnum text-[12px] text-ink-2 w-12 text-center cursor-pointer hover:text-ink" aria-label="Reset zoom">{Math.round(zoom * 100)}%</button>
              <Button variant="ghost" size="iconSm" disabled={zoom >= 2.4} onClick={() => setZoom((z) => +(z + 0.2).toFixed(1))} aria-label="Zoom in"><ZoomIn size={15} /></Button>
            </div>
            <div ref={scroller} className="flex-1 overflow-auto scroll-thin p-4 sm:p-6">
              <div className="relative paper mx-auto rounded-[2px]" style={{ width: `${zoom * 100}%`, maxWidth: zoom <= 1 ? 820 : "none" }}>
                {src ? <img src={src} alt={`Page ${page} of ${r.fileName}`} className="block w-full h-auto select-none" draggable={false} />
                  : src === undefined ? <div className="aspect-[8.5/11] grid place-items-center text-[#8a8f98]"><Loader2 size={22} className="animate-spin" /></div>
                  : <TextPage r={r} page={page} quote={f?.ev.page === page ? f.ev.quote : null} />}
                {src && onPage.map((x) => x.ev.boxes.map((b, k) => (
                  <button key={`${x.i}-${k}`} onClick={() => ctx.setEvidence({ id: r.id, i: x.i })} aria-label={k === 0 ? `Highlight: ${x.label}` : undefined} tabIndex={k === 0 ? 0 : -1}
                    className={cn("hl cursor-pointer", JSON.stringify(x.ev.boxes) === activeKey && "on")}
                    style={{ "--hc": CATS[x.cat].color, left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` }} />
                )))}
              </div>
            </div>
          </div>
        </div>

        {/* on this page */}
        <div className="bg-surface border-t border-line px-4 py-2.5">
          <div className="flex items-center gap-2 text-[12px] text-ink-3 mb-1.5"><span>On this page</span><span className="tnum">{onPage.length}</span></div>
          <div className="flex gap-1.5 overflow-x-auto no-scrollbar pb-0.5">
            {onPage.length ? onPage.map((x) => (
              <button key={x.i} onClick={() => ctx.setEvidence({ id: r.id, i: x.i })}
                className={cn("shrink-0 max-w-[240px] inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border text-[12px] cursor-pointer", JSON.stringify(x.ev.boxes) === activeKey ? "border-ink bg-ink text-bg" : "border-line bg-surface text-ink-2 hover:border-line-2")}>
                <span className="w-2 h-2 rounded-[2px] shrink-0" style={{ background: CATS[x.cat].color }} /><span className="truncate">{x.label}</span>
              </button>
            )) : <span className="text-[12px] text-ink-3">No findings on this page.</span>}
          </div>
        </div>
      </motion.aside>
    </>
  );
}

function Thumb({ docId, page }) {
  const ref = useRef(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setSeen(true); io.disconnect(); } }, { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const src = usePageImage(seen ? docId : null, page, 0.25);
  return <div ref={ref} className="aspect-[8.5/11] bg-white">{src && <img src={src} alt="" className="block w-full" />}</div>;
}

/* Without the stored PDF (another browser, or storage was full) show the page text instead. */
function TextPage({ r, page, quote }) {
  const text = r.pages?.[page - 1];
  if (!text) return <div className="aspect-[8.5/11] grid place-items-center p-8 text-center text-[13px] text-[#5b606a]">The original PDF isn&apos;t stored in this browser, so the page can&apos;t be shown. Upload it again to see the highlights.</div>;
  const flat = text.replace(/\s+/g, " ");
  const q = quote?.replace(/\s+/g, " ");
  const at = q ? flat.toLowerCase().indexOf(q.toLowerCase()) : -1;
  return (
    <div className="p-8 text-[13px] leading-[1.7] text-[#1d1f24] whitespace-pre-wrap">
      <div className="mb-3 text-[11px] text-[#8a8f98]">Page text (the PDF itself isn&apos;t stored in this browser)</div>
      {at < 0 ? flat : <>{flat.slice(0, at)}<mark className="marked bg-transparent text-inherit">{flat.slice(at, at + q.length)}</mark>{flat.slice(at + q.length)}</>}
    </div>
  );
}
