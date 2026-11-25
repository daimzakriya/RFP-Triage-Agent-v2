import { Check, AlertTriangle } from "lucide-react";
import { CATS, cn, findings, relText, urgency, STATUS } from "./lib";
import { Hover, Badge } from "./ui";

/* The entry point into the PDF: page number with a highlighter swatch; hover shows the quote. */
export function Source({ r, ev, ctx, active }) {
  if (!ev || ev._i == null) return null;
  const f = findings(r)[ev._i];
  const cat = CATS[f.cat];
  const missing = ev.check === "unverified";
  const exact = !missing && ev.conf === "exact";
  const on = active ?? (ctx.evidence?.id === r.id && ctx.evidence?.i === ev._i);
  return (
    <Hover
      content={
        <div className="text-[12.5px]">
          <div className="flex items-center justify-between gap-3 text-ink-3">
            <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-[3px]" style={{ background: cat.color }} />{cat.label}</span>
            <span className="font-mono">Page {ev.page}</span>
          </div>
          <blockquote className="mt-2 text-[13.5px] leading-[1.6] text-ink"><span className="marked" style={{ "--hc": f.cat === "other" ? "var(--hilite)" : cat.color }}>{ev.quote.replace(/\s+/g, " ")}</span></blockquote>
          <div className="mt-2.5 flex items-center justify-between text-ink-3">
            <span className={cn("inline-flex items-center gap-1", exact ? "text-bid" : missing ? "text-nobid" : "text-warn")}>{exact ? <Check size={13} strokeWidth={2.6} /> : <AlertTriangle size={13} />}{exact ? "Found word for word" : missing ? "Not found in the document. Check by hand" : "Close match. Read the passage to confirm"}</span>
            <span>Click to open in the PDF</span>
          </div>
        </div>
      }
    >
      <button
        onClick={(e) => { e.stopPropagation(); ctx.setEvidence({ id: r.id, i: ev._i }); }}
        aria-label={`Open page ${ev.page} of the PDF with this passage highlighted`}
        className={cn(
          "inline-flex items-center gap-1.5 h-6 pl-1.5 pr-2 rounded-md border font-mono text-[11.5px] font-medium align-middle cursor-pointer transition-all",
          on ? "border-ink bg-ink text-bg" : "border-line-2 bg-surface text-ink-2 hover:border-ink-3 hover:text-ink hover:-translate-y-px",
        )}
      >
        <span className="w-2.5 h-2.5 rounded-[3px] -rotate-6" style={{ background: cat.color }} />
        p.{ev.page}
        {exact ? <Check size={12} strokeWidth={2.8} className={on ? "" : "text-bid"} /> : <AlertTriangle size={11} className={missing ? "text-nobid" : "text-warn"} />}
      </button>
    </Hover>
  );
}
export const Sources = ({ r, evs, ctx }) => <span className="inline-flex flex-wrap gap-1 align-middle">{(evs || []).map((ev, k) => <Source key={k} r={r} ev={ev} ctx={ctx} />)}</span>;

/* Signature element: every page of the RFP, with a highlighter tick per finding taken from it. */
export function EvidenceMap({ r, ctx, compact, current }) {
  const list = findings(r);
  const pages = Array.from({ length: r.pageCount }, (_, i) => i + 1);
  const byPage = (p) => list.filter((f) => f.ev.page === p);
  const max = Math.max(1, ...pages.map((p) => byPage(p).length));
  return (
    <div className={cn("flex items-end gap-[3px]", compact ? "h-9" : "h-14")} role="group" aria-label={`Evidence map: ${list.length} findings across ${r.pageCount} pages`}>
      {pages.map((p) => {
        const fs = byPage(p);
        const cats = [...new Set(fs.map((f) => f.cat))];
        return (
          <button key={p}
            onClick={() => (fs.length ? ctx.setEvidence({ id: r.id, i: fs[0].i }) : ctx.setEvidence({ id: r.id, page: p }))}
            aria-label={`Page ${p}: ${fs.length} finding${fs.length === 1 ? "" : "s"}`}
            title={`Page ${p}, ${fs.length} finding${fs.length === 1 ? "" : "s"}`}
            className={cn("group relative flex-1 min-w-[10px] h-full rounded-[3px] border flex flex-col-reverse overflow-hidden cursor-pointer transition-all",
              current === p ? "border-ink ring-2 ring-ink/15" : "border-line hover:border-ink-3", fs.length ? "bg-surface" : "bg-subtle")}>
            <span className="absolute top-0.5 inset-x-0 text-center font-mono text-[9px] text-ink-3 leading-none">{compact ? "" : p}</span>
            {cats.map((c) => {
              const n = fs.filter((f) => f.cat === c).length;
              return <span key={c} style={{ height: `${Math.max(14, (n / max) * (compact ? 80 : 66))}%`, background: CATS[c].color }} className="w-full opacity-85 group-hover:opacity-100 border-t border-surface" />;
            })}
          </button>
        );
      })}
    </div>
  );
}

export function StatusBadge({ s }) { const x = STATUS[s]; return <Badge tone={x.tone} dot>{x.label}</Badge>; }
export function Rel({ iso, className }) {
  if (!iso) return null;
  const u = urgency(iso);
  return <span className={cn("tnum text-[12px] whitespace-nowrap", u === "urgent" ? "text-nobid font-semibold" : u === "soon" ? "text-warn font-semibold" : "text-ink-3", className)}>{relText(iso)}</span>;
}
export function Decision({ r, size = "md" }) {
  const bid = r.decision === "BID";
  const tone = r.degraded || r.decision === "UNDETERMINED" ? "warn" : bid ? "bid" : "nobid";
  return <Badge tone={tone} dot className={size === "lg" ? "h-6.5 px-2.5 text-[12.5px]" : ""}>{tone === "warn" ? "No call yet" : bid ? "Bid" : "No bid"}</Badge>;
}
export function Meter({ value, max = 10, tone = "accent", className }) {
  const c = { accent: "bg-hilite", bid: "bg-bid", nobid: "bg-nobid", eval: "bg-[var(--c-evaluation)]" }[tone];
  return <div className={cn("h-1.5 rounded-full bg-muted overflow-hidden", className)}><div className={cn("h-full rounded-full", c)} style={{ width: `${(value / max) * 100}%` }} /></div>;
}
