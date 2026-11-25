import { useRef, useState } from "react";
import { motion } from "motion/react";
import { UploadCloud, FileText, Check, Layers, HardDrive, Clock, ScanText, ArrowRight, AlertTriangle, RefreshCw, Trash2 } from "lucide-react";
import { LIMITS } from "@/lib/limits";
import { cn, fmtDate, shortId, STAGES } from "../lib";
import { Button, Card, CardHead, Tip } from "../ui";
import { Decision } from "../parts";

export default function Analyze({ ctx, job, queue, errors, elapsed, addFiles }) {
  const [over, setOver] = useState(false);
  const input = useRef(null);
  const stage = job ? STAGES.findIndex((s) => s.id === job.stage) : -1;
  const reports = ctx.reports;

  return (
    <div className="h-full overflow-y-auto scroll-thin">
      <div className="max-w-[1240px] mx-auto px-4 sm:px-8 py-8">
        <h1 className="text-[24px] font-semibold tracking-[-0.025em]">{reports.length ? "New analysis" : "Should we bid on this one?"}</h1>
        <p className="text-ink-2 mt-1.5 mb-7 max-w-[70ch]">Drop in a government RFP. About a minute later you&apos;ll know whether idiaz.io should bid, what winning it would take, and exactly where the document says so.</p>

        <div className="grid lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] gap-6 items-start">
          <div className="grid gap-5">
            <div
              onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
              onDrop={(e) => { e.preventDefault(); setOver(false); addFiles(e.dataTransfer.files); }}
              className={cn("relative rounded-2xl border-2 border-dashed bg-surface p-8 sm:p-10 text-center transition-colors", over ? "border-accent bg-accent-soft" : "border-line-2")}
            >
              <div className="mx-auto w-14 h-14 rounded-2xl grid place-items-center bg-hilite text-on-hilite mb-4"><UploadCloud size={26} /></div>
              <h2 className="text-[18px] font-semibold tracking-[-0.01em]">Drop RFP PDFs here</h2>
              <p className="text-ink-3 mt-1">or choose them from your computer. Several files run one after another.</p>
              <Button variant="primary" size="lg" className="mt-5" onClick={() => input.current?.click()}><FileText size={16} />Choose PDFs</Button>
              <input ref={input} type="file" accept="application/pdf,.pdf" multiple className="sr-only" aria-label="Choose RFP PDF files" onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
              <div className="mt-7 grid grid-cols-2 sm:grid-cols-4 gap-3 text-left">
                {[[ScanText, "Text-based PDF", "Scans need OCR first"], [Layers, `Up to ${LIMITS.maxPages} pages`, "Long RFPs are fine"], [HardDrive, `${LIMITS.maxFileBytes / 1048576} MB per file`, "PDF format only"], [Clock, "About a minute", "Per document"]].map(([I, a, b]) => (
                  <div key={a} className="rounded-xl bg-subtle px-3 py-2.5"><I size={15} className="text-ink-3 mb-1" /><div className="text-[12.5px] font-medium">{a}</div><div className="text-[11.5px] text-ink-3">{b}</div></div>
                ))}
              </div>
            </div>

            <div aria-live="polite" className="grid gap-3">
              {job && (
                <Card>
                  <CardHead title={job.name} sub="Analysing" right={<span className="tnum text-[12.5px] text-ink-3">{elapsed}s</span>} />
                  <div className="p-4.5">
                    <div className="h-1.5 rounded-full bg-muted overflow-hidden mb-4"><motion.div className="h-full bg-hilite rounded-full" animate={{ width: `${Math.min(95, stage === 0 ? 8 : 15 + elapsed * 1.6)}%` }} transition={{ duration: 0.5 }} /></div>
                    <ol>
                      {STAGES.map((s, i) => {
                        const st = i < stage ? "done" : i === stage ? "active" : "todo";
                        return (
                          <li key={s.id} className="relative flex gap-3 pb-3 last:pb-0">
                            {i < STAGES.length - 1 && <span className={cn("absolute left-[9px] top-5 bottom-0 w-px", st === "done" ? "bg-bid" : "bg-line")} />}
                            <span className={cn("relative z-10 mt-0.5 w-[19px] h-[19px] rounded-full grid place-items-center shrink-0 border-2", st === "done" ? "bg-bid border-bid text-white" : st === "active" ? "border-accent border-t-transparent animate-spin" : "border-line-2 bg-surface")}>
                              {st === "done" && <Check size={11} strokeWidth={3.2} />}
                            </span>
                            <span className={cn("text-[13.5px]", st === "todo" ? "text-ink-3" : "text-ink", st === "active" && "font-semibold")}>{s.label}{st === "active" && <span className="sr-only"> (in progress)</span>}</span>
                          </li>
                        );
                      })}
                    </ol>
                    {elapsed > 45 && <p className="mt-3 text-[12.5px] text-ink-3">{elapsed > 90 ? "This one is taking longer than usual. Still working, and it can take a couple of minutes." : "Long documents take a little longer. Still working…"}</p>}
                  </div>
                </Card>
              )}
              {queue.length > 0 && (
                <Card>
                  <CardHead title="Waiting" sub={`${queue.length} file${queue.length > 1 ? "s" : ""} queued`} />
                  <ul>{queue.map((f, i) => (
                    <li key={i} className="flex items-center gap-3 px-4.5 py-2.5 border-b border-line last:border-0 text-[13.5px]"><PdfIcon /><span className="flex-1 truncate">{f.kind === "file" ? f.file.name : f.name}</span><span className="text-[12px] text-ink-3">{f.kind === "retry" ? "Retry" : "Queued"}</span></li>
                  ))}</ul>
                </Card>
              )}
              {errors.map((e, i) => {
                const [msg, detail] = e.message.split(" Details:");
                return (
                  <div key={i} role="alert" className="flex gap-3 rounded-xl border border-nobid/30 bg-nobid-soft px-4 py-3 text-[13.5px]">
                    <AlertTriangle size={16} className="text-nobid shrink-0 mt-0.5" />
                    <div className="min-w-0"><b>{e.file}.</b> <span className="text-ink-2">{msg}</span>
                      {detail && <details className="mt-1.5"><summary className="text-[12.5px] text-ink-3 cursor-pointer">Technical details</summary><div className="text-[12.5px] text-ink-3 mt-1 break-words">{detail}</div></details>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="grid gap-5">
            {reports.length > 0 ? (
              <Card>
                <CardHead title="Analysed in this browser" sub={`${reports.length} report${reports.length > 1 ? "s" : ""} on the Bid Desk`} />
                <ul>{reports.slice(0, 8).map((r) => (
                  <li key={r.id} className="flex items-center gap-3 px-4.5 py-3 border-b border-line last:border-0">
                    <div className="min-w-0 flex-1"><div className="font-medium leading-snug line-clamp-2">{r.title}</div><div className="text-[12px] text-ink-3 mt-0.5 tnum">{shortId(r)}, {r.pageCount} pages, {fmtDate(r.generatedAt.slice(0, 10))}</div></div>
                    <Decision r={r} />
                    {r.degraded && ctx.actions.canRetry(r.id) ? <Button size="sm" disabled={ctx.busy} onClick={() => ctx.actions.retry(r.id)}><RefreshCw size={13} />Retry</Button>
                      : <Button size="sm" onClick={() => ctx.go(`#report-${r.id}`)}>Open<ArrowRight size={13} /></Button>}
                    <Tip content="Remove from desk"><Button variant="ghost" size="iconSm" className="text-ink-3 hover:text-nobid hover:bg-nobid-soft" onClick={() => ctx.actions.remove(r.id)} aria-label={`Remove ${r.title}`}><Trash2 size={14} /></Button></Tip>
                  </li>
                ))}</ul>
              </Card>
            ) : (
              <Card className="overflow-hidden">
                <CardHead title="What you get" sub="Every finding links to the sentence that proves it" />
                <div className="p-5 bg-subtle">
                  <div className="paper rounded-[3px] p-5 text-[13px] leading-[1.75] text-[#1d1f24]">
                    <div className="flex justify-between text-[10.5px] text-[#8a8f98] mb-3"><span>Request for Proposals</span><span>Page 5</span></div>
                    <p><span className="marked" style={{ "--hc": "var(--c-date)" }}>Proposals due January 15, 2027, 3:00 PM Pacific.</span> Late submissions will not be opened.</p>
                    <p className="mt-2">The proposer <span className="marked" style={{ "--hc": "var(--c-mandatory)" }}>must hold SOC 2 Type II or FedRAMP hosting</span> and encrypt all data at rest.</p>
                    <p className="mt-2"><span className="marked" style={{ "--hc": "var(--c-evaluation)" }}>Technical approach is worth 30 of 100 points</span>, cost 20 and references 20.</p>
                    <p className="mt-2">Contract value <span className="marked" style={{ "--hc": "var(--c-contract)" }}>not to exceed $420,000</span> over a three-year term.</p>
                  </div>
                </div>
                <ul className="p-4.5 grid gap-2.5 text-[13px] text-ink-2">
                  <li className="flex gap-2.5"><Check size={15} className="text-bid shrink-0 mt-0.5" />A bid or no-bid call with a 0 to 10 fit score</li>
                  <li className="flex gap-2.5"><Check size={15} className="text-bid shrink-0 mt-0.5" />Requirements checked against the idiaz.io profile</li>
                  <li className="flex gap-2.5"><Check size={15} className="text-bid shrink-0 mt-0.5" />Deadlines, scoring, submission checklist and deal-breakers</li>
                </ul>
              </Card>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const PdfIcon = () => <div className="w-7 h-9 shrink-0 rounded-md border border-line-2 bg-surface grid place-items-end pb-1 text-[8px] font-bold text-nobid relative"><span className="absolute top-0 right-0 w-2 h-2 bg-subtle border-l border-b border-line-2 rounded-bl" />PDF</div>;
