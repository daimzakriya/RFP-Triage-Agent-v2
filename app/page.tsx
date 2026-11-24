"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BidDesk } from "@/components/BidDesk";
import { Icon, Mark } from "@/components/Icon";
import { SourceContext } from "@/components/Evidence";
import { Report } from "@/components/Report";
import { PdfEvidenceViewer } from "@/components/PdfEvidenceViewer";
import { loadDesk, rankDesk, saveDesk, type DeskItem } from "@/lib/desk";
import { locateAll, type TextRun } from "@/lib/evidence-map";
import { deletePdf, putPdf } from "@/lib/pdf-store";
import { reportsToIcs } from "@/lib/ics";
import { extractPdfPages, LIMITS, PdfInputError } from "@/lib/pdf";
import type { TriageReport, VerifiedEvidence } from "@/lib/schema";

type Stage = "reading" | "analysing" | "checking";
const STAGES: { id: Stage; label: string }[] = [
  { id: "reading", label: "Reading every page of the PDF" },
  { id: "analysing", label: "Extracting facts, dates and requirements" },
  { id: "checking", label: "Checking quotes against the document and scoring fit" },
];

type QueueItem = { kind: "file"; file: File } | { kind: "retry"; name: string; pages: string[]; replaceId: string; docId?: string };

/** Text positions captured when each PDF was read, kept for retries in this session. */
const runsByDoc = new Map<string, TextRun[][]>();

interface Job {
  name: string;
  stage: Stage;
  startedAt: number;
}

function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function slug(r: TriageReport) {
  return (r.solicitation_number || r.title || "rfp").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

export default function Home() {
  const [desk, setDesk] = useState<DeskItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [job, setJob] = useState<Job | null>(null);
  const [errors, setErrors] = useState<{ file: string; message: string }[]>([]);
  const [tab, setTab] = useState<"report" | "json">("report");
  const [source, setSource] = useState<VerifiedEvidence | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const reportRef = useRef<HTMLDivElement>(null);
  const loaded = useRef(false);

  useEffect(() => {
    const items = loadDesk();
    setDesk(items);
    if (items.length) setSelectedId(rankDesk(items)[0].id);
    loaded.current = true;
  }, []);
  useEffect(() => {
    if (loaded.current) saveDesk(desk);
  }, [desk]);

  useEffect(() => {
    if (!job) return;
    const t = setInterval(() => setElapsed(Math.round((Date.now() - job.startedAt) / 1000)), 500);
    return () => clearInterval(t);
  }, [job]);

  const runOne = useCallback(async (q: QueueItem) => {
    const startedAt = Date.now();
    const name = q.kind === "file" ? q.file.name : q.name;
    setElapsed(0);
    setJob({ name, stage: q.kind === "file" ? "reading" : "analysing", startedAt });
    try {
      let pages: string[];
      let docId: string | undefined = q.kind === "retry" ? q.docId : undefined;
      if (q.kind === "file") {
        const file = q.file;
        if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
          throw new PdfInputError("Only PDF files are supported.", "not_pdf");
        }
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
      let res: Response;
      try {
        res = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileName: name, pages }),
        });
      } finally {
        clearTimeout(checkingTimer);
      }
      const data = await res.json().catch(() => ({ error: `Server error (HTTP ${res.status}).` }));
      if (!res.ok) throw new Error(data.error || `Server error (HTTP ${res.status}).`);
      setJob({ name, stage: "checking", startedAt });

      const report = data as TriageReport;
      // Locate every quoted finding in the PDF once, now, and keep the result with the report.
      const runs = docId ? runsByDoc.get(docId) : undefined;
      let locations: DeskItem["locations"];
      try {
        locations = runs ? locateAll(report, runs) : undefined;
      } catch {
        locations = undefined;
      }
      const item: DeskItem = { id: crypto.randomUUID(), addedAt: new Date().toISOString(), report, pages, docId, locations };
      setDesk((d) => {
        const replaced = (x: DeskItem) =>
          (q.kind === "retry" && x.id === q.replaceId) ||
          (x.report.document.fileName === name && x.report.solicitation_number === item.report.solicitation_number);
        const kept = d.filter((x) => !replaced(x));
        // drop stored PDFs that no report points to any more
        for (const x of d) if (replaced(x) && x.docId && x.docId !== docId && !kept.some((k) => k.docId === x.docId)) void deletePdf(x.docId);
        return [item, ...kept];
      });
      setSelectedId(item.id);
      setTab("report");
      setTimeout(() => reportRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setErrors((e) => [...e, { file: name, message }]);
    } finally {
      setJob(null);
    }
  }, []);

  // Process the queue one file at a time (keeps within the free model's rate limits).
  useEffect(() => {
    if (job || queue.length === 0) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    void runOne(next);
  }, [queue, job, runOne]);

  function addFiles(list: FileList | null) {
    if (!list?.length) return;
    const files = Array.from(list); // copy now: the FileList is live and is cleared when the input resets
    setErrors([]);
    setQueue((q) => [...q, ...files.map((file) => ({ kind: "file" as const, file }))]);
  }

  const selected = desk.find((d) => d.id === selectedId) ?? null;
  const stageIndex = job ? STAGES.findIndex((s) => s.id === job.stage) : -1;
  const bids = desk.filter((d) => d.report.decision === "BID").length;

  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  const SECTIONS: { id: string; label: string; icon: string }[] = [
    { id: "sec-verdict", label: "Verdict", icon: "target" },
    { id: "sec-summary", label: "Summary", icon: "summary" },
    { id: "sec-requirements", label: "Requirements", icon: "checks" },
    { id: "sec-dates", label: "Key dates", icon: "calendar" },
    { id: "sec-fit", label: "Fit score", icon: "gauge" },
    { id: "sec-scoring", label: "Scoring & submission", icon: "scale" },
    { id: "sec-risks", label: "Deal-breakers", icon: "alert" },
  ];

  return (
    <SourceContext.Provider value={setSource}>
      <div className="app">
        <div className="bg-glow" aria-hidden="true" />
        {/* ---------- sidebar ---------- */}
        <aside className="side no-print" aria-label="Navigation">
          <div className="side-brand">
            <Mark />
            <div>
              <b>idiaz.io</b>
              <span>RFP Triage Agent</span>
            </div>
          </div>
          <nav className="side-nav">
            <button className="side-link" onClick={() => jump("sec-upload")}>
              <Icon name="upload" /> New analysis
            </button>
            <button className="side-link" onClick={() => jump("sec-desk")}>
              <Icon name="desk" /> Bid Desk
              {desk.length > 0 && <span className="side-count">{desk.length}</span>}
            </button>
            {selected && tab === "report" && (
              <>
                <div className="side-label">This report</div>
                {SECTIONS.map((x) => (
                  <button key={x.id} className="side-link sub" onClick={() => jump(x.id)}>
                    <Icon name={x.icon} /> {x.label}
                  </button>
                ))}
              </>
            )}
          </nav>
          <div className="side-status">
            <div className="pulse-row">
              <span className={`pulse ${job ? "busy" : ""}`} aria-hidden="true" />
              {job ? "Analysing…" : "Ready"}
            </div>
            <div className="small muted">Gemini 3.x · Mistral & Nemotron backups · every quote checked against the PDF</div>
          </div>
        </aside>

        {/* ---------- main ---------- */}
        <main className="main">
          <header className="topbar">
            <div className="crumbs">
              <span className="muted">Workspace</span>
              <span className="muted">/</span>
              <span>{selected ? selected.report.solicitation_number || selected.report.title : "New analysis"}</span>
            </div>
            <div className="top-stats" aria-label="Bid Desk summary">
              <span className="stat-pill"><b>{desk.length}</b> triaged</span>
              <span className="stat-pill bid"><b>{bids}</b> worth bidding</span>
            </div>
          </header>

          <section id="sec-upload" className="launch">
            <div className="launch-copy">
              <div className="eyebrow"><Icon name="sparkles" size={14} /> AI bid/no-bid triage</div>
              <h1>
                Drop an RFP.<br />
                <span className="grad">Get the bid call.</span>
              </h1>
              <p className="lede">
                A fit score against the idiaz.io profile, every deadline and requirement, deal-breakers and questions for the agency.
                Every fact links to the sentence in the PDF that proves it.
              </p>
              <ul className="feature-pills">
                <li><Icon name="clock" size={14} /> about a minute</li>
                <li><Icon name="shield" size={14} /> evidence-checked</li>
                <li><Icon name="eye" size={14} /> highlights in the PDF</li>
                <li><Icon name="layers" size={14} /> many RFPs at once</li>
              </ul>
            </div>

            <div className="launch-drop">
              <div
                className={`drop ${dragOver ? "over" : ""} ${job ? "busy" : ""}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  addFiles(e.dataTransfer.files);
                }}
              >
                <div className="drop-icon" aria-hidden="true">
                  <Icon name="file" size={30} />
                </div>
                <p className="big">Drag RFP PDFs here</p>
                <p className="muted small">or</p>
                <button className="btn btn-primary btn-lg" onClick={() => inputRef.current?.click()}>
                  <Icon name="upload" /> Choose PDF files
                </button>
                <input
                  ref={inputRef}
                  type="file"
                  accept="application/pdf,.pdf"
                  multiple
                  className="sr-only"
                  aria-label="Choose RFP PDF files"
                  onChange={(e) => {
                    addFiles(e.target.files);
                    e.target.value = "";
                  }}
                />
                <div className="limits">
                  Text-based PDF · up to {LIMITS.maxPages} pages · {LIMITS.maxFileBytes / 1048576} MB · several files run one after another
                </div>
              </div>

              <div aria-live="polite">
                {job && (
                  <div className="card job">
                    <div className="scan" aria-hidden="true">
                      <div className="scan-doc">
                        <i /><i /><i /><i /><i /><i />
                      </div>
                      <div className="scan-beam" />
                    </div>
                    <div className="job-body">
                      <div className="card-head" style={{ marginBottom: 0 }}>
                        <strong className="job-name">{job.name}</strong>
                        <span className="days">{elapsed}s</span>
                      </div>
                      <ol className="steps">
                        {STAGES.map((s, i) => (
                          <li key={s.id} className={i < stageIndex ? "done" : i === stageIndex ? "active" : ""}>
                            <span className="dot" aria-hidden="true">{i < stageIndex ? "✓" : ""}</span>
                            {s.label}
                            {i === stageIndex && <span className="sr-only"> (in progress)</span>}
                          </li>
                        ))}
                      </ol>
                      <div className="bar" aria-hidden="true">
                        <span style={{ width: `${Math.min(95, stageIndex === 0 ? 8 : 15 + elapsed * 1.6)}%` }} />
                      </div>
                      {elapsed > 45 && (
                        <p className="small muted" style={{ marginBottom: 0 }}>
                          {elapsed > 90
                            ? "The free AI model is busy, so the agent is retrying or switching to a backup model. This can take up to a few minutes."
                            : "Long documents take a little longer. Still working…"}
                        </p>
                      )}
                    </div>
                  </div>
                )}
                {queue.length > 0 && (
                  <ul className="queue" aria-label="Waiting to be analysed">
                    {queue.map((f, i) => (
                      <li key={i}>
                        <span>{f.kind === "file" ? f.file.name : `${f.name} (retry)`}</span>
                        <span className="muted">queued</span>
                      </li>
                    ))}
                  </ul>
                )}
                {errors.map((e, i) => (
                  <div key={i} className="alert alert-error" role="alert" style={{ marginTop: 10 }}>
                    <Icon name="alert" />
                    <span>
                      <strong>{e.file}:</strong> {e.message.split(" Details:")[0]}
                      {e.message.includes(" Details:") && (
                        <details style={{ marginTop: 6 }}>
                          <summary className="small" style={{ cursor: "pointer" }}>Technical details</summary>
                          <span className="small">{e.message.split(" Details:")[1]}</span>
                        </details>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <div id="sec-desk">
            <BidDesk
              items={desk}
              selectedId={selectedId}
              onSelect={(id) => {
                setSelectedId(id);
                setTimeout(() => reportRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
              }}
              onRemove={(id) => {
                const gone = desk.find((x) => x.id === id);
                if (gone?.docId && !desk.some((x) => x.id !== id && x.docId === gone.docId)) void deletePdf(gone.docId);
                setDesk((d) => d.filter((x) => x.id !== id));
                if (selectedId === id) setSelectedId(null);
              }}
              onExportAll={() => {
                const bidReports = desk.filter((d) => d.report.decision === "BID").map((d) => d.report);
                download("bid-desk-deadlines.ics", reportsToIcs(bidReports.length ? bidReports : desk.map((d) => d.report)), "text/calendar");
              }}
            />
          </div>

          <div ref={reportRef} className="report-anchor">
            {selected && (
              <>
                <div className="tabs no-print" role="tablist" aria-label="Report views">
                  <button role="tab" className="tab" aria-selected={tab === "report"} onClick={() => setTab("report")}>
                    <Icon name="summary" /> Report
                  </button>
                  <button role="tab" className="tab" aria-selected={tab === "json"} onClick={() => setTab("json")}>
                    <Icon name="code" /> JSON
                  </button>
                  <span style={{ flex: 1 }} />
                  <button className="btn btn-ghost btn-sm" onClick={() => download(`${slug(selected.report)}-triage.json`, JSON.stringify(selected.report, null, 2), "application/json")}>
                    <Icon name="download" /> JSON
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => window.print()}>
                    <Icon name="printer" /> Print / PDF
                  </button>
                </div>
                {tab === "report" ? (
                  <Report
                    report={selected.report}
                    retrying={!!job || queue.some((q) => q.kind === "retry" && q.replaceId === selected.id)}
                    onRetry={
                      selected.pages
                        ? () => setQueue((q) => [...q, { kind: "retry", name: selected.report.document.fileName, pages: selected.pages!, replaceId: selected.id, docId: selected.docId }])
                        : undefined
                    }
                    onDownloadIcs={() => download(`${slug(selected.report)}-deadlines.ics`, reportsToIcs([selected.report]), "text/calendar")}
                  />
                ) : (
                  <div>
                    <p className="small muted">
                      The exact payload returned by <code>POST /api/analyze</code>. It is validated with a schema, and every quote carries a <code>check</code> result.
                    </p>
                    <pre className="json" tabIndex={0} aria-label="Report JSON">{JSON.stringify(selected.report, null, 2)}</pre>
                  </div>
                )}
              </>
            )}
          </div>

          <footer className="foot">
            <span>idiaz.io // make software do the work</span>
            <span>AI output is advisory. Check flagged items against the source.</span>
          </footer>
        </main>
      </div>
      <PdfEvidenceViewer evidence={source} item={selected} onClose={() => setSource(null)} />
    </SourceContext.Provider>
  );
}
