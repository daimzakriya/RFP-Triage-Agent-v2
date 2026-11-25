"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Command } from "cmdk";
import * as DialogP from "@radix-ui/react-dialog";
import { AnimatePresence, motion } from "motion/react";
import { FileUp, LayoutList, Search, Plus, Moon, Sun, Menu as MenuIcon, FileText, Command as CmdIcon, CornerDownLeft } from "lucide-react";
import { loadDesk, rankDesk, saveDesk } from "@/lib/desk";
import { locateAll } from "@/lib/evidence-map";
import { deletePdf, putPdf } from "@/lib/pdf-store";
import { reportsToIcs } from "@/lib/ics";
import { extractPdfPages, LIMITS, PdfInputError } from "@/lib/pdf";
import { viewOf } from "@/lib/view";
import { Report as PrintReport } from "@/components/Report";
import { cn, findings, findingText, CATS, TABS, shortId } from "./lib";
import { Button, Kbd, TipProvider, Tip } from "./ui";
import Sidebar from "./Sidebar";
import Desk from "./views/Desk";
import Analyze from "./views/Analyze";
import Report from "./views/Report";


/** Text positions captured when each PDF was read, kept for retries in this session. */
const runsByDoc = new Map();

function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const slug = (r) => (r.solicitation_number || r.title || "rfp").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

/* plain #name routes: #desk, #analyze, #report-<id>, #report-<id>--<tab> */
function parseHash() {
  const h = location.hash.slice(1);
  if (h.startsWith("report-")) {
    const [id, tab] = h.slice(7).split("--");
    return { view: "report", id, tab: TABS.some((t) => t.id === tab) ? tab : "overview" };
  }
  if (h === "analyze") return { view: "analyze" };
  if (h === "desk") return { view: "desk" };
  return { view: "home" };
}

export default function App() {
  const [desk, setDesk] = useState([]);
  const loaded = useRef(false);
  const [route, setRoute] = useState(parseHash);
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  const [collapsed, setCollapsed] = useState(false);
  const [cmd, setCmd] = useState(false);
  const [nav, setNav] = useState(false);
  const [toast, setToast] = useState(null);
  const [evidence, setEvidence] = useState(null); // { id, i } or { id, page }

  /* ---------- the Bid Desk, kept in this browser ---------- */
  useEffect(() => { setDesk(loadDesk()); loaded.current = true; }, []);
  useEffect(() => { if (loaded.current) saveDesk(desk); }, [desk]);
  const ranked = useMemo(() => rankDesk(desk), [desk]);
  const reports = useMemo(() => ranked.map(viewOf), [ranked]);
  const byId = useMemo(() => Object.fromEntries(ranked.map((it) => [it.id, it])), [ranked]);

  /* ---------- analysis queue: one PDF at a time ---------- */
  const [queue, setQueue] = useState([]);
  const [job, setJob] = useState(null);
  const [errors, setErrors] = useState([]);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!job) return;
    const t = setInterval(() => setElapsed(Math.round((Date.now() - job.startedAt) / 1000)), 500);
    return () => clearInterval(t);
  }, [job]);

  const runOne = useCallback(async (q) => {
    const startedAt = Date.now();
    const name = q.kind === "file" ? q.file.name : q.name;
    setElapsed(0);
    setJob({ name, stage: q.kind === "file" ? "reading" : "analysing", startedAt });
    try {
      let pages;
      let docId = q.kind === "retry" ? q.docId : undefined;
      if (q.kind === "file") {
        const file = q.file;
        if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") throw new PdfInputError("Only PDF files are supported.", "not_pdf");
        const bytes = new Uint8Array(await file.arrayBuffer());
        const extracted = await extractPdfPages(bytes, { positions: true });
        if (extracted.characters > LIMITS.maxChars) {
          throw new PdfInputError(`This PDF has ${extracted.characters.toLocaleString()} characters of text. The limit is ${LIMITS.maxChars.toLocaleString()}.`, "too_large");
        }
        pages = extracted.pages;
        // Keep the original PDF in this browser so findings can be shown highlighted in it.
        docId = crypto.randomUUID();
        if (extracted.runs) runsByDoc.set(docId, extracted.runs);
        if (!(await putPdf(docId, bytes))) docId = undefined;
      } else {
        pages = q.pages; // retry: reuse the text already read from the PDF
      }

      setJob({ name, stage: "analysing", startedAt });
      const checkingTimer = setTimeout(() => setJob((j) => (j ? { ...j, stage: "checking" } : j)), 25_000);
      let res;
      try {
        res = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fileName: name, pages }) });
      } finally {
        clearTimeout(checkingTimer);
      }
      const data = await res.json().catch(() => ({ error: `Server error (HTTP ${res.status}).` }));
      if (!res.ok) throw new Error(data.error || `Server error (HTTP ${res.status}).`);
      setJob({ name, stage: "checking", startedAt });

      const report = data;
      // Locate every quoted finding in the PDF once, now, and keep the result with the report.
      const runs = docId ? runsByDoc.get(docId) : undefined;
      let locations;
      try { locations = runs ? locateAll(report, runs) : undefined; } catch { locations = undefined; }
      const item = { id: crypto.randomUUID(), addedAt: new Date().toISOString(), report, pages, docId, locations };
      setDesk((d) => {
        const replaced = (x) => (q.kind === "retry" && x.id === q.replaceId) || (x.report.document.fileName === name && x.report.solicitation_number === item.report.solicitation_number);
        const kept = d.filter((x) => !replaced(x));
        for (const x of d) if (replaced(x) && x.docId && x.docId !== docId && !kept.some((k) => k.docId === x.docId)) void deletePdf(x.docId);
        return [item, ...kept];
      });
      location.hash = `#report-${item.id}`;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setErrors((e) => [...e, { file: name, message }]);
    } finally {
      setJob(null);
    }
  }, []);

  useEffect(() => {
    if (job || queue.length === 0) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    void runOne(next);
  }, [queue, job, runOne]);

  const addFiles = useCallback((list) => {
    if (!list?.length) return;
    const files = Array.from(list); // copy now: the FileList is live and clears when the input resets
    setErrors([]);
    setQueue((q) => [...q, ...files.map((file) => ({ kind: "file", file }))]);
  }, []);

  /* ---------- routing, theme, shortcuts ---------- */
  useEffect(() => { const f = () => setRoute(parseHash()); addEventListener("hashchange", f); return () => removeEventListener("hashchange", f); }, []);
  useEffect(() => { document.documentElement.classList.toggle("dark", dark); try { localStorage.setItem("rfp-theme", dark ? "dark" : "light"); } catch { /* storage may be blocked */ } }, [dark]);
  useEffect(() => {
    const k = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setCmd((v) => !v); return; }
      if (e.metaKey || e.ctrlKey || e.altKey || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || document.querySelector("[role=dialog]")) return;
      if (e.key === "n") location.hash = "#analyze";
      if (e.key === "d") location.hash = "#desk";
    };
    addEventListener("keydown", k); return () => removeEventListener("keydown", k);
  }, []);

  // resolve the route against what is on the desk
  const view = route.view === "home" ? (loaded.current && !desk.length ? "analyze" : "desk") : route.view === "report" && !byId[route.id] ? "desk" : route.view;
  const item = view === "report" ? byId[route.id] : null;
  const rep = item ? viewOf(item) : null;
  const shown = { ...route, view };

  useEffect(() => { if (view !== "report" || (evidence && evidence.id !== route.id)) setEvidence(null); }, [view, route.id]); // eslint-disable-line

  const go = useCallback((hash) => { setNav(false); if (location.hash === hash) setRoute(parseHash()); else location.hash = hash; }, []);
  const notify = useCallback((msg) => setToast({ msg, k: Date.now() }), []);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 3400); return () => clearTimeout(t); }, [toast]);

  const actions = {
    remove: (id) => {
      const gone = desk.find((x) => x.id === id);
      if (gone?.docId && !desk.some((x) => x.id !== id && x.docId === gone.docId)) void deletePdf(gone.docId);
      setDesk((d) => d.filter((x) => x.id !== id));
      notify("Removed from the Bid Desk.");
    },
    icsFor: (id) => { const it = byId[id]; if (it) download(`${slug(it.report)}-deadlines.ics`, reportsToIcs([it.report]), "text/calendar"); },
    icsAll: () => {
      const bidReports = desk.filter((d) => d.report.decision === "BID").map((d) => d.report);
      download("bid-desk-deadlines.ics", reportsToIcs(bidReports.length ? bidReports : desk.map((d) => d.report)), "text/calendar");
    },
    json: (id) => { const it = byId[id]; if (it) download(`${slug(it.report)}-triage.json`, JSON.stringify(it.report, null, 2), "application/json"); },
    print: () => window.print(),
    retry: (id) => {
      const it = byId[id];
      if (!it?.pages) return;
      setQueue((q) => [...q, { kind: "retry", name: it.report.document.fileName, pages: it.pages, replaceId: it.id, docId: it.docId }]);
      go("#analyze");
    },
    canRetry: (id) => !!byId[id]?.pages,
  };
  const ctx = { go, notify, evidence, setEvidence, openCmd: () => setCmd(true), reports, actions, busy: !!job || queue.length > 0 };

  return (
    <TipProvider>
      <div className="app-screen h-full">
        <div className={cn("h-full grid transition-[grid-template-columns] duration-200", collapsed ? "lg:grid-cols-[68px_minmax(0,1fr)]" : "lg:grid-cols-[264px_minmax(0,1fr)]")}>
          <aside className={cn("fixed inset-y-0 left-0 z-40 w-[280px] lg:static lg:w-auto transition-transform lg:translate-x-0", nav ? "translate-x-0 shadow-pop" : "-translate-x-full")}>
            <Sidebar reports={reports} route={shown} go={go} job={job} queued={queue.length} dark={dark} setDark={setDark} collapsed={collapsed} setCollapsed={setCollapsed} mobile={nav} onClose={() => setNav(false)} />
          </aside>
          {nav && <div className="fixed inset-0 z-30 bg-black/40 lg:hidden" onClick={() => setNav(false)} />}

          <div className="min-w-0 min-h-0 flex flex-col h-full" style={{ backgroundImage: "var(--wash)", backgroundRepeat: "no-repeat" }}>
            <header className="h-14 shrink-0 flex items-center gap-3 px-4 sm:px-6 border-b border-line bg-bg/80 backdrop-blur-md">
              <Button variant="ghost" size="icon" className="lg:hidden -ml-1" onClick={() => setNav(true)} aria-label="Open navigation"><MenuIcon size={18} /></Button>
              <nav className="flex items-center gap-2 text-[13.5px] min-w-0" aria-label="Breadcrumb">
                {rep ? (<>
                  <button onClick={() => go("#desk")} className="text-ink-3 hover:text-ink cursor-pointer hidden sm:inline">Bid Desk</button>
                  <span className="text-ink-3 hidden sm:inline">/</span>
                  <span className="tnum text-[13px] font-medium truncate">{shortId(rep)}</span>
                </>) : <span className="font-medium">{view === "analyze" ? "New analysis" : "Bid Desk"}</span>}
              </nav>
              <div className="flex-1" />
              <Button variant="ghost" size="icon" className="sm:hidden" onClick={() => setCmd(true)} aria-label="Search"><Search size={17} /></Button>
              <Button variant="outline" className="hidden sm:inline-flex text-ink-3 w-56 justify-start" onClick={() => setCmd(true)}><Search size={14} />Search findings… <span className="ml-auto"><Kbd>Ctrl K</Kbd></span></Button>
              <Tip content={dark ? "Switch to light theme" : "Switch to dark theme"}><Button variant="ghost" size="icon" onClick={() => setDark(!dark)} aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}>{dark ? <Sun size={17} /> : <Moon size={17} />}</Button></Tip>
              <Button variant="primary" onClick={() => go("#analyze")}><Plus size={15} strokeWidth={2.4} /><span className="hidden sm:inline">New analysis</span></Button>
            </header>
            <main className="flex-1 min-h-0 relative">
              {view === "desk" && <Desk ctx={ctx} />}
              {view === "analyze" && <Analyze ctx={ctx} job={job} queue={queue} errors={errors} elapsed={elapsed} addFiles={addFiles} />}
              {view === "report" && rep && <Report key={rep.id} r={rep} tab={route.tab} ctx={ctx} />}
            </main>
          </div>
        </div>

        <CommandPalette reports={reports} open={cmd} setOpen={setCmd} go={go} openEvidence={(id, i) => { go(`#report-${id}`); setTimeout(() => setEvidence({ id, i }), 30); }} dark={dark} setDark={setDark} />

        <AnimatePresence>
          {toast && (
            <motion.div key={toast.k} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} role="status"
              className="fixed z-[60] bottom-5 left-1/2 -translate-x-1/2 rounded-xl bg-ink text-bg px-3.5 py-2.5 text-[13px] shadow-pop max-w-[92vw]">
              {toast.msg}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* The printed report keeps its own document layout. */}
      {item && <div className="print-root"><PrintReport report={item.report} onDownloadIcs={() => {}} /></div>}
    </TipProvider>
  );
}

function CommandPalette({ reports, open, setOpen, go, openEvidence, dark, setDark }) {
  const [q, setQ] = useState("");
  const all = useMemo(() => reports.flatMap((r) => findings(r).map((f) => ({ r, f }))), [reports]);
  const hits = q.trim().length > 1 ? all.filter(({ f }) => findingText(f).includes(q.toLowerCase())).slice(0, 30) : [];
  const run = (fn) => { setOpen(false); setQ(""); fn(); };
  return (
    <DialogP.Root open={open} onOpenChange={setOpen}>
      <DialogP.Portal>
        <DialogP.Overlay className="fixed inset-0 z-50 bg-ink/35 backdrop-blur-[2px]" />
        <DialogP.Content aria-describedby={undefined} className="fixed z-50 left-1/2 top-[12vh] -translate-x-1/2 w-[min(640px,94vw)] rounded-2xl border border-line bg-surface shadow-pop overflow-hidden">
          <DialogP.Title className="sr-only">Search and jump</DialogP.Title>
          <Command shouldFilter={!hits.length} loop>
            <div className="flex items-center gap-2.5 px-4 border-b border-line">
              <CmdIcon size={16} className="text-ink-3" />
              <Command.Input value={q} onValueChange={setQ} placeholder="Search findings, reports and sections…" className="h-12 flex-1 bg-transparent outline-none focus-visible:outline-none text-[14.5px] placeholder:text-ink-3" />
              <Kbd>Esc</Kbd>
            </div>
            <Command.List className="max-h-[56vh] overflow-y-auto p-2 scroll-thin">
              <Command.Empty>No matches.</Command.Empty>
              {hits.length > 0 && (
                <Command.Group heading={`Findings (${hits.length})`}>
                  {hits.map(({ r, f }) => (
                    <Command.Item key={r.id + f.i} value={`${r.id}-${f.i}-${f.label}`} onSelect={() => run(() => openEvidence(r.id, f.i))}>
                      <span className="w-2.5 h-2.5 rounded-[3px] shrink-0" style={{ background: CATS[f.cat].color }} />
                      <span className="truncate flex-1">{f.label}</span>
                      <span className="tnum text-[11.5px] text-ink-3 shrink-0">{shortId(r)}, p.{f.ev.page}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {!hits.length && (<>
                <Command.Group heading="Go to">
                  <Command.Item onSelect={() => run(() => go("#desk"))}><LayoutList size={15} />Bid Desk</Command.Item>
                  <Command.Item onSelect={() => run(() => go("#analyze"))}><FileUp size={15} />New analysis</Command.Item>
                </Command.Group>
                {reports.map((r) => (
                  <Command.Group key={r.id} heading={r.title}>
                    {TABS.map((t) => (
                      <Command.Item key={t.id} value={`${r.id} ${r.title} ${t.label}`} onSelect={() => run(() => go(`#report-${r.id}--${t.id}`))}>
                        <FileText size={15} /><span className="flex-1">{t.label}</span><span className="text-[11.5px] text-ink-3 tnum">{shortId(r)}</span>
                      </Command.Item>
                    ))}
                  </Command.Group>
                ))}
                <Command.Group heading="Preferences">
                  <Command.Item onSelect={() => run(() => setDark(!dark))}>{dark ? <Sun size={15} /> : <Moon size={15} />}Switch to {dark ? "light" : "dark"} theme</Command.Item>
                </Command.Group>
              </>)}
            </Command.List>
            <div className="flex items-center gap-3 px-4 h-9 border-t border-line text-[11.5px] text-ink-3"><span className="inline-flex items-center gap-1"><CornerDownLeft size={12} />open</span><span>↑↓ move</span><span className="ml-auto">Type 2+ letters to search every finding</span></div>
          </Command>
        </DialogP.Content>
      </DialogP.Portal>
    </DialogP.Root>
  );
}
