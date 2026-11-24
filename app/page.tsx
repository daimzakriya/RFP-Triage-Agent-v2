"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BidDesk } from "@/components/BidDesk";
import { SourceContext } from "@/components/Evidence";
import { Report } from "@/components/Report";
import { SourceViewer } from "@/components/SourceViewer";
import { loadDesk, rankDesk, saveDesk, type DeskItem } from "@/lib/desk";
import { reportsToIcs } from "@/lib/ics";
import { extractPdfPages, LIMITS, PdfInputError } from "@/lib/pdf";
import type { TriageReport, VerifiedEvidence } from "@/lib/schema";

type Stage = "reading" | "analysing" | "checking";
const STAGES: { id: Stage; label: string }[] = [
  { id: "reading", label: "Reading every page of the PDF" },
  { id: "analysing", label: "Extracting facts, dates and requirements" },
  { id: "checking", label: "Checking quotes against the document and scoring fit" },
];

type QueueItem = { kind: "file"; file: File } | { kind: "retry"; name: string; pages: string[]; replaceId: string };

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
      if (q.kind === "file") {
        const file = q.file;
        if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
          throw new PdfInputError("Only PDF files are supported.", "not_pdf");
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        const extracted = await extractPdfPages(bytes);
        if (extracted.characters > LIMITS.maxChars) {
          throw new PdfInputError(`This PDF has ${extracted.characters.toLocaleString()} characters of text. The limit is ${LIMITS.maxChars.toLocaleString()}.`, "too_large");
        }
        pages = extracted.pages;
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

      const item: DeskItem = { id: crypto.randomUUID(), addedAt: new Date().toISOString(), report: data as TriageReport, pages };
      setDesk((d) => [
        item,
        ...d.filter(
          (x) =>
            !(q.kind === "retry" && x.id === q.replaceId) &&
            !(x.report.document.fileName === name && x.report.solicitation_number === item.report.solicitation_number),
        ),
      ]);
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

  return (
    <SourceContext.Provider value={setSource}>
      <div className="shell">
        <header className="topbar">
          <div className="brand">
            <b>IDIAZ.IO</b>
            <span>// rfp triage agent</span>
          </div>
          <span className="label no-print">Free-tier · evidence-checked</span>
        </header>

        <div className={`grid-2 ${desk.length ? "has-desk" : ""}`}>
          <div className="uploader-col">
            <div className="label"><span className="num">→</span>Drop in an RFP</div>
            <h1>
              Should we <mark>bid</mark>?
            </h1>
            <p className="lede">
              Upload a government RFP. In about a minute you get a bid/no-bid call, a 0–10 fit score against the idiaz.io profile, every key date
              and requirement, and a page-and-quote source for each fact, checked against the PDF.
            </p>

            <div
              className={`drop ${dragOver ? "over" : ""}`}
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
              <p className="big">Drag RFP PDFs here</p>
              <p className="muted small">or</p>
              <button className="btn btn-primary" onClick={() => inputRef.current?.click()}>
                Choose PDF files
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
                Text-based PDF · up to {LIMITS.maxPages} pages · {LIMITS.maxFileBytes / 1048576} MB · several files are analysed one after another
              </div>
            </div>

            <div aria-live="polite" style={{ marginTop: 14 }}>
              {job && (
                <div className="card">
                  <div className="card-head" style={{ marginBottom: 0 }}>
                    <strong>{job.name}</strong>
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
                  <span aria-hidden="true">✕</span>
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

          <BidDesk
            items={desk}
            selectedId={selectedId}
            onSelect={(id) => {
              setSelectedId(id);
              setTimeout(() => reportRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
            }}
            onRemove={(id) => {
              setDesk((d) => d.filter((x) => x.id !== id));
              if (selectedId === id) setSelectedId(null);
            }}
            onExportAll={() => {
              const bids = desk.filter((d) => d.report.decision === "BID").map((d) => d.report);
              download("bid-desk-deadlines.ics", reportsToIcs(bids.length ? bids : desk.map((d) => d.report)), "text/calendar");
            }}
          />
        </div>

        <div ref={reportRef}>
          {selected && (
            <>
              <div className="tabs no-print" role="tablist" aria-label="Report views">
                <button role="tab" className="tab" aria-selected={tab === "report"} onClick={() => setTab("report")}>
                  Report
                </button>
                <button role="tab" className="tab" aria-selected={tab === "json"} onClick={() => setTab("json")}>
                  JSON
                </button>
                <span style={{ flex: 1 }} />
                <button className="btn btn-ghost btn-sm" onClick={() => download(`${slug(selected.report)}-triage.json`, JSON.stringify(selected.report, null, 2), "application/json")}>
                  ↓ JSON
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => window.print()}>
                  Print / PDF
                </button>
              </div>
              {tab === "report" ? (
                <Report
                  report={selected.report}
                  retrying={!!job || queue.some((q) => q.kind === "retry" && q.replaceId === selected.id)}
                  onRetry={
                    selected.pages
                      ? () => setQueue((q) => [...q, { kind: "retry", name: selected.report.document.fileName, pages: selected.pages!, replaceId: selected.id }])
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
      </div>
      <SourceViewer evidence={source} pages={selected?.pages} onClose={() => setSource(null)} />
    </SourceContext.Provider>
  );
}
