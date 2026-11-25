import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import * as Collapsible from "@radix-ui/react-collapsible";
import { CalendarPlus, ChevronDown, Copy, FileText, ShieldCheck, AlertTriangle, Info, Check, Search, X, Map as MapIcon, MoreHorizontal, Download, Printer, RefreshCw, Trash2 } from "lucide-react";
import { TABS, CATS, cn, derive, findings, findingText, fmtDate, fmtShort, toDate, shortId } from "../lib";
import { Button, Card, CardHead, Badge, Segmented, Checkbox, Tip, Menu, MenuTrigger, MenuContent, MenuItem, MenuSep } from "../ui";
import { Sources, EvidenceMap, StatusBadge, Rel, Meter, Decision } from "../parts";
import Viewer from "./Viewer";

export default function Report({ r, tab, ctx }) {
  const d = useMemo(() => derive(r), [r]);
  const list = findings(r);
  const scroller = useRef(null);
  const [q, setQ] = useState("");
  const open = ctx.evidence && ctx.evidence.id === r.id;
  const tabs = TABS.filter((t) => !(t.id === "contract" && !r.terms.length) && !(t.id === "scoring" && !r.criteria.length && !r.submission.length && !r.award) && !(t.id === "fit" && r.degraded));
  const counts = { requirements: r.requirements.length, dates: r.dates.filter((x) => x.date).length, risks: r.dealBreakers.length, contract: r.terms.length };
  const setTab = (t) => { history.replaceState(null, "", `#report-${r.id}--${t}`); dispatchEvent(new HashChangeEvent("hashchange")); scroller.current?.scrollTo({ top: 0 }); };
  const rctx = { ctx, r, d, setTab };

  // flash the finding we return to
  const back = () => {
    const f = list[ctx.evidence?.i];
    ctx.setEvidence(null);
    if (!f) return;
    if (f.tab !== tab) setTab(f.tab);
    setTimeout(() => {
      const el = document.querySelector(`[data-f="${f.i}"]`);
      if (el && scroller.current) { scroller.current.scrollTo({ top: el.getBoundingClientRect().top - scroller.current.getBoundingClientRect().top + scroller.current.scrollTop - scroller.current.clientHeight / 3, behavior: "smooth" }); el.animate([{ backgroundColor: "color-mix(in srgb, var(--c-date) 30%, transparent)" }, { backgroundColor: "transparent" }], { duration: 1600 }); }
    }, 60);
  };
  const Body = { overview: Overview, requirements: Requirements, dates: Dates, fit: Fit, scoring: Scoring, contract: Contract, risks: Risks }[tab];

  return (
    <div className={cn("h-full grid", open ? "xl:grid-cols-[minmax(0,1fr)_minmax(460px,48%)]" : "grid-cols-1")}>
      <div ref={scroller} className="@container min-w-0 h-full overflow-y-auto scroll-thin">
        <header className="border-b border-line bg-surface/60">
          <div className="max-w-[1360px] px-4 @2xl:px-8 pt-7">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12.5px] text-ink-3">
              <Decision r={r} /><span className="tnum text-ink-2 font-medium">{shortId(r)}</span>{r.agency && <><span className="w-px h-3 bg-line-2" /><span>{r.agency}</span></>}
            </div>
            <h1 className="mt-3 text-[25px] @2xl:text-[30px] leading-[1.12] font-semibold tracking-[-0.03em] max-w-[56ch] text-balance">{r.title}</h1>
            <div className="mt-5 grid @2xl:grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-2 items-end">
              <div className="min-w-0">
                <div className="flex items-center justify-between text-[12px] text-ink-3 mb-1.5">
                  <span className="inline-flex items-center gap-1.5"><MapIcon size={13} />Where the {list.length} findings come from, page by page</span>
                  <span className="hidden @3xl:inline">Click a page to open it</span>
                </div>
                <EvidenceMap r={r} ctx={ctx} current={open ? (ctx.evidence.page ?? list[ctx.evidence.i]?.ev.page) : null} />
              </div>
              <div className="flex items-center gap-2">
                <Button onClick={() => ctx.setEvidence(list.length ? { id: r.id, i: 0 } : { id: r.id, page: 1 })}><FileText size={15} />Open PDF</Button>
                <Menu>
                  <MenuTrigger asChild><Button size="icon" aria-label="More actions"><MoreHorizontal size={16} /></Button></MenuTrigger>
                  <MenuContent>
                    <MenuItem onSelect={() => ctx.actions.icsFor(r.id)}><CalendarPlus size={15} />Add deadlines to calendar</MenuItem>
                    <MenuItem onSelect={ctx.actions.print}><Printer size={15} />Print or save as PDF</MenuItem>
                    <MenuItem onSelect={() => ctx.actions.json(r.id)}><Download size={15} />Download JSON</MenuItem>
                    {ctx.actions.canRetry(r.id) && <MenuItem disabled={ctx.busy} onSelect={() => ctx.actions.retry(r.id)}><RefreshCw size={15} />Run the analysis again</MenuItem>}
                    <MenuSep />
                    <MenuItem onSelect={() => { ctx.actions.remove(r.id); ctx.go("#desk"); }} className="text-nobid data-[highlighted]:text-nobid"><Trash2 size={15} />Remove from desk</MenuItem>
                  </MenuContent>
                </Menu>
              </div>
            </div>
            <nav className="mt-4 -mb-px flex gap-1 overflow-x-auto no-scrollbar" role="tablist" aria-label="Report sections">
              {tabs.map((t) => (
                <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
                  className={cn("relative isolate h-11 px-3 text-[14px] whitespace-nowrap cursor-pointer inline-flex items-center gap-1.5", tab === t.id ? "text-ink font-semibold" : "text-ink-3 hover:text-ink")}>
                  {t.label}{counts[t.id] != null && <span className="tnum text-[11px] px-1.5 rounded-full bg-subtle text-ink-2">{counts[t.id]}</span>}
                  {tab === t.id && <motion.span layoutId={`tab-${r.id}`} className="absolute -z-10 left-1.5 right-1.5 bottom-[11px] h-[10px] rounded-[3px] -rotate-[0.6deg] bg-hilite/70 dark:bg-hilite/35" />}
                </button>
              ))}
            </nav>
          </div>
        </header>
        <div className="max-w-[1360px] px-4 @2xl:px-8 py-7">
          <InReport q={q} setQ={setQ} rctx={rctx} />
          <AnimatePresence mode="wait">
            <motion.div key={tab} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }}>
              <Body rctx={rctx} />
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
      <AnimatePresence>{open && <Viewer key="viewer" r={r} ctx={ctx} onBack={back} />}</AnimatePresence>
    </div>
  );
}

/* search inside this report */
function InReport({ q, setQ, rctx }) {
  const { r, ctx } = rctx;
  const hits = q.trim().length > 1 ? findings(r).filter((f) => findingText(f).includes(q.toLowerCase())) : [];
  return (
    <div className="mb-5">
      <label className="relative block max-w-md">
        <Search size={14} className="absolute left-3 top-[11px] text-ink-3" />
        <span className="sr-only">Search this report</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search this report, e.g. insurance, SOC 2, addendum" className="h-9 w-full rounded-lg border border-line-2 bg-surface pl-9 pr-9 text-[13.5px] outline-none focus:border-accent focus:ring-3 focus:ring-accent-soft" />
        {q && <button onClick={() => setQ("")} aria-label="Clear search" className="absolute right-2 top-2 p-0.5 text-ink-3 hover:text-ink cursor-pointer"><X size={15} /></button>}
      </label>
      {q.trim().length > 1 && (
        <Card className="mt-3">
          <CardHead title={`${hits.length} finding${hits.length === 1 ? "" : "s"} match “${q}”`} />
          {hits.length ? hits.slice(0, 14).map((f) => (
            <button key={f.i} onClick={() => ctx.setEvidence({ id: r.id, i: f.i })} className="w-full flex items-center gap-3 px-4.5 py-2.5 border-b border-line last:border-0 text-left hover:bg-subtle cursor-pointer">
              <span className="w-2.5 h-2.5 rounded-[3px] shrink-0" style={{ background: CATS[f.cat].color }} />
              <span className="flex-1 min-w-0 truncate text-[13.5px]">{f.label}</span>
              <span className="text-[12px] text-ink-3 hidden @2xl:inline">{TABS.find((t) => t.id === f.tab).label}</span>
              <span className="tnum text-[11.5px] text-ink-3">p.{f.ev.page}</span>
            </button>
          )) : <div className="px-4.5 py-6 text-ink-3 text-[13px]">Nothing in this report matches.</div>}
        </Card>
      )}
    </div>
  );
}

/* ---------------- Overview ---------------- */
function Overview({ rctx }) {
  const { r, d, ctx, setTab } = rctx;
  const bid = r.decision === "BID";
  const es = r.evidenceStats;
  const passed = r.quality ? r.quality.checks.filter((x) => x.status === "pass").length : 0;
  const mustMet = d.musts.filter((q) => q.status === "meets").length;
  const mustVerify = d.musts.filter((q) => q.status === "verify").length;
  const mustFail = d.musts.filter((q) => q.status === "fails").length;
  const tone = r.degraded ? "text-warn" : bid ? "text-bid" : "text-nobid";
  return (
    <div className="grid gap-8">
      {/* the call: no box, the verdict carries the page */}
      <section aria-label="Recommendation">
        <div className="grid @3xl:grid-cols-[minmax(240px,auto)_minmax(0,1fr)] gap-x-12 gap-y-5 items-start">
          <div>
            <div className="text-[12.5px] text-ink-3">Our call</div>
            <div className={cn("mt-1 font-semibold leading-[0.88] tracking-[-0.05em]", r.degraded ? "text-[48px] @2xl:text-[56px]" : "text-[64px] @2xl:text-[80px]", tone)}>{r.degraded ? "No call yet" : bid ? "Bid" : "No bid"}</div>
            {r.degraded ? (ctx.actions.canRetry(r.id) && <Button variant="primary" className="mt-5" disabled={ctx.busy} onClick={() => ctx.actions.retry(r.id)}><RefreshCw size={15} />Retry full analysis</Button>)
              : <FitScale value={r.fit} tone={bid ? "var(--bid)" : "var(--nobid)"} />}
            {r.fastNoBid && <div className="mt-3"><Badge tone="nobid">Ruled out early</Badge></div>}
          </div>
          <div className="min-w-0 @3xl:pt-5">
            <p className="text-[20px] @2xl:text-[23px] leading-[1.3] font-medium tracking-[-0.02em] text-ink max-w-[42ch] text-pretty">{d.headline}</p>
            <p className="mt-3 text-[13px] text-ink-3 max-w-[60ch]">{r.degraded ? "Every AI provider was busy, so the dates and requirements below come from a text search of the PDF." : bid ? "We recommend bidding at 6/10 or above when nothing blocks eligibility." : r.fastNoBid ? "Stopped early: a blocking requirement rules it out." : "Below 6/10, or blocked by a deal-breaker."}</p>
            {r.decisionNote && <div className="mt-4 flex gap-2.5 rounded-lg bg-info-soft px-3 py-2.5 text-[13px] text-ink-2 max-w-[70ch]"><Info size={15} className="shrink-0 mt-0.5 text-info" />{r.decisionNote}</div>}
            <div className="mt-6 inline-flex max-w-full flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-line bg-surface pl-4 pr-2 py-2 shadow-card">
              <span className="text-[12.5px] text-ink-3">Next step</span>
              <span className="text-[14px] font-medium">{d.nextAction.title}</span>
              {d.nextAction.date && <span className="text-[13px] text-ink-2 tnum">{fmtShort(d.nextAction.date)}, <Rel iso={d.nextAction.date} /></span>}
              {d.nextAction.date && <Button size="sm" onClick={() => ctx.actions.icsFor(r.id)}><CalendarPlus size={13} />Add to calendar</Button>}
            </div>
          </div>
        </div>
        <div className="mt-7 grid grid-cols-2 @4xl:grid-cols-4 border-y border-line">
          <Fig label="Proposal due" value={fmtDate(d.due?.date)} sub={<>{d.due?.time && <span>{d.due.time}, </span>}<Rel iso={d.due?.date} /></>} />
          <Fig label="Contract value" value={d.value || (r.facts.find((f) => f.key === "contract_value")?.notStated ? "Not stated" : "See summary")} muted={!d.value} sub={d.value ? (/not[- ]to[- ]exceed|ceiling|cap|max/i.test(r.facts.find((f) => f.key === "contract_value").value) ? "Ceiling" : "As stated") : "No figure given"} />
          <Fig label="Must-haves" value={d.musts.length} sub={<span><span className="text-bid">{mustMet} met</span>, <span className="text-warn">{mustVerify} to verify</span>, <span className={mustFail ? "text-nobid" : ""}>{mustFail} can&apos;t meet</span></span>} onClick={() => setTab("requirements")} />
          <Fig label="Deal-breakers" value={r.dealBreakers.length} tone={d.blocking ? "text-nobid" : r.dealBreakers.length ? "text-warn" : "text-bid"} sub={d.blocking ? `${d.blocking} blocking` : r.dealBreakers.length ? "None blocking" : "None found"} onClick={() => setTab("risks")} />
        </div>
      </section>

      <div className="grid @4xl:grid-cols-2 gap-x-12 gap-y-8 py-2">
        <section>
          <h2 className="text-[15px] font-semibold tracking-[-0.01em]">Why we landed here</h2>
          <ol className="mt-3.5 grid gap-3.5">{r.reasons.map((x, i) => <li key={i} className="flex gap-3 text-[14px] text-ink-2 leading-relaxed"><span className={cn("mt-0.5 w-5 h-5 shrink-0 rounded-full grid place-items-center text-[11px] font-semibold tnum", bid ? "bg-bid-soft text-bid" : "bg-nobid-soft text-nobid")}>{i + 1}</span>{x}</li>)}</ol>
        </section>
        <section>
          <h2 className="text-[15px] font-semibold tracking-[-0.01em]">What would change the call</h2>
          <ul className="mt-3.5 grid gap-3.5">{r.changeMind.map((x, i) => <li key={i} className="flex gap-3 text-[14px] text-ink-2 leading-relaxed"><AlertTriangle size={15} className="mt-1 shrink-0 text-warn" />{x}</li>)}</ul>
        </section>
      </div>

      <Card>
        <CardHead title={<span className="inline-flex items-center gap-2"><ShieldCheck size={16} className="text-bid" />Can you trust it?</span>} sub="Every quote is checked against the PDF before you see it" />
        <div className="p-4.5 grid @4xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-6">
          <div>
            <div className="flex items-baseline gap-2"><span className="text-[26px] font-semibold tnum tracking-[-0.02em]">{es.verified}<span className="text-ink-3 text-[15px]">/{es.total}</span></span><span className="text-ink-2 text-[13px]">quotes found word for word</span></div>
            <div className="flex h-2 rounded-full overflow-hidden bg-muted mt-2.5">
              <span className="bg-bid" style={{ width: `${(es.verified / Math.max(1, es.total)) * 100}%` }} /><span className="bg-[var(--c-date)]" style={{ width: `${(es.approximate / Math.max(1, es.total)) * 100}%` }} /><span className="bg-nobid" style={{ width: `${(es.unverified / Math.max(1, es.total)) * 100}%` }} />
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[12px] text-ink-2">
              <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-bid" />{es.verified} exact</span>
              <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-[var(--c-date)]" />{es.approximate} close match</span>
              <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-nobid" />{es.unverified} not found</span>
            </div>
            {r.flags.map((f, i) => (
              <div key={i} className={cn("mt-3 flex gap-2.5 rounded-lg px-3 py-2.5 text-[12.5px] leading-snug", f.level === "warning" ? "bg-warn-soft text-warn" : "bg-info-soft text-info")}>
                {f.level === "warning" ? <AlertTriangle size={15} className="shrink-0 mt-px" /> : <Info size={15} className="shrink-0 mt-px" />}<span className="text-ink-2">{f.text}</span>
              </div>
            ))}
          </div>
          {r.quality ? (
          <Collapsible.Root defaultOpen>
            <Collapsible.Trigger className="group flex items-center gap-2 text-[13px] font-medium cursor-pointer">
              <ChevronDown size={15} className="transition-transform group-data-[state=closed]:-rotate-90" />Quality checks <Badge tone={r.quality.status === "verified" ? "bid" : r.quality.status === "needs_review" ? "warn" : "nobid"}>{passed}/{r.quality.checks.length} passed</Badge>
            </Collapsible.Trigger>
            <Collapsible.Content>
              <ul className="mt-3 grid @2xl:grid-cols-2 gap-x-4 gap-y-1.5">{r.quality.checks.map((c) => (
                <li key={c.label} className="flex items-start gap-2 text-[12.5px] text-ink-2">
                  <span className={cn("mt-0.5 w-4 h-4 rounded-full grid place-items-center shrink-0", c.status === "pass" ? "bg-bid-soft text-bid" : c.status === "warn" ? "bg-warn-soft text-warn" : "bg-nobid-soft text-nobid")}>{c.status === "pass" ? <Check size={10} strokeWidth={3.2} /> : <AlertTriangle size={9} strokeWidth={3} />}</span>
                  <Tip content={c.detail}><span className="cursor-default">{c.label}</span></Tip>
                </li>))}</ul>
            </Collapsible.Content>
          </Collapsible.Root>) : <p className="text-[12.5px] text-ink-3">{r.flags.length ? "" : "No conflicts, ambiguities or unverified quotes were found."}</p>}
        </div>
      </Card>

      <Card>
        <CardHead title="Executive summary" />
        <div className="p-4.5">
          <p className="text-[14px] text-ink-2 leading-relaxed max-w-[75ch]">{r.summary}</p>
          <dl className="mt-4 divide-y divide-line border-t border-line">
            {r.facts.map((f) => (
              <Row key={f.label} f={f.ev[0]?._i} onOpen={f.ev[0] ? () => ctx.setEvidence({ id: r.id, i: f.ev[0]._i }) : null}>
                <dt className="text-[13px] text-ink-3 @2xl:w-40 shrink-0">{f.label}</dt>
                <dd className="text-[13.5px] min-w-0">{f.notStated ? <span className="text-ink-3 italic">Not stated</span> : f.value} {f.review && <Badge tone="warn">Check source</Badge>} <Sources r={r} evs={f.ev} ctx={ctx} />{f.note && <div className="text-[12.5px] text-ink-3 mt-1">{f.note}</div>}</dd>
              </Row>
            ))}
          </dl>
        </div>
      </Card>
    </div>
  );
}
function Row({ f, onOpen, children }) {
  return <div data-f={f} onClick={onOpen ?? undefined} className={cn("flex flex-col @2xl:flex-row gap-1 @2xl:gap-4 py-3 px-1 -mx-1 rounded-md", onOpen && "cursor-pointer hover:bg-subtle")}>{children}</div>;
}
function Fig({ label, value, sub, tone, muted, onClick }) {
  const C = onClick ? "button" : "div";
  return (
    <C onClick={onClick} className={cn("group py-4 pr-4 pl-4 text-left min-w-0 border-line [&:nth-child(even)]:border-l [&:nth-child(n+3)]:border-t @4xl:[&:nth-child(n+3)]:border-t-0 @4xl:[&:nth-child(3)]:border-l @max-4xl:[&:nth-child(odd)]:pl-0 @4xl:first:pl-0", onClick && "cursor-pointer")}>
      <div className="text-[12px] text-ink-3">{label}</div>
      <div className={cn("text-[21px] font-semibold tracking-[-0.02em] tnum mt-1 leading-tight", tone, muted && "text-ink-3 font-medium", onClick && "group-hover:underline decoration-hilite decoration-[3px] underline-offset-4")}>{value}</div>
      <div className="text-[12.5px] text-ink-2 mt-1">{sub}</div>
    </C>
  );
}
/* fit on a 0 to 10 rule, with the bid line marked */
function FitScale({ value, tone }) {
  return (
    <div className="mt-6 w-[280px] max-w-full">
      <div className="flex items-baseline gap-1.5"><span className="text-[30px] font-semibold tnum tracking-[-0.03em] leading-none">{value}</span><span className="text-ink-3 text-[13px]">out of 10 fit</span></div>
      <div className="relative mt-3.5 h-2 rounded-full bg-muted">
        <motion.div className="absolute inset-y-0 left-0 rounded-full" style={{ background: tone }} initial={{ width: 0 }} animate={{ width: `${value * 10}%` }} transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }} />
        <span className="absolute -top-1.5 -bottom-1.5 w-[2px] rounded-full bg-ink" style={{ left: "60%" }} />
      </div>
      <div className="relative mt-1.5 h-4 text-[11px] text-ink-3 tnum">
        <span className="absolute left-0">0</span><span className="absolute -translate-x-1/2 text-ink-2" style={{ left: "60%" }}>bid line</span><span className="absolute right-0">10</span>
      </div>
    </div>
  );
}

function Requirements({ rctx }) {
  const { r, ctx } = rctx;
  const [status, setStatus] = useState("all");
  const [must, setMust] = useState(false);
  const [closed, setClosed] = useState({});
  const groups = [...new Set(r.requirements.map((x) => x.group))];
  const rows = r.requirements.filter((x) => (status === "all" || x.status === status) && (!must || x.must));
  const n = (s) => r.requirements.filter((x) => x.status === s).length;
  return (
    <div className="grid gap-5">
      {!r.requirements.length && <Card className="p-8 text-center text-ink-3">No requirements were stated in this RFP.</Card>}
      {r.requirements.length > 0 && <>
      <Card className="p-4.5">
        <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3"><h2 className="text-[14px] font-semibold">Compliance overview</h2><span className="text-[12.5px] text-ink-3">{n("meets")} meet, {n("verify")} to verify, {n("fails")} can&apos;t meet</span></div>
        <div className="grid @2xl:grid-cols-2 gap-x-8 gap-y-2.5">
          {groups.map((g) => {
            const gs = r.requirements.filter((x) => x.group === g);
            return (
              <div key={g} className="grid grid-cols-[130px_minmax(0,1fr)_28px] items-center gap-3 text-[12.5px]">
                <span className="truncate text-ink-2">{g}</span>
                <span className="flex h-2 rounded-full overflow-hidden bg-muted">{["meets", "verify", "fails"].map((s) => { const c = gs.filter((x) => x.status === s).length; return c ? <span key={s} className={s === "meets" ? "bg-bid" : s === "verify" ? "bg-[var(--c-date)]" : "bg-nobid"} style={{ width: `${(c / gs.length) * 100}%` }} /> : null; })}</span>
                <span className="tnum text-right text-ink-3">{gs.length}</span>
              </div>
            );
          })}
        </div>
      </Card>
      <div className="flex flex-wrap items-center gap-3">
        <Segmented label="Filter by status" value={status} onChange={setStatus} items={[{ value: "all", label: "All", count: r.requirements.length }, { value: "meets", label: "Meets", count: n("meets") }, { value: "verify", label: "Verify", count: n("verify") }, { value: "fails", label: "Can't meet", count: n("fails") }]} />
        <label className="inline-flex items-center gap-2 text-[13px] text-ink-2 cursor-pointer"><Checkbox checked={must} onCheckedChange={(v) => setMust(!!v)} label="Must-have only" />Must-have only</label>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setClosed(Object.keys(closed).length ? {} : Object.fromEntries(groups.map((g) => [g, true])))}>{Object.keys(closed).length ? "Expand all" : "Collapse all"}</Button>
      </div>
      <Card className="overflow-hidden">
        {groups.map((g) => {
          const gs = rows.filter((x) => x.group === g);
          if (!gs.length) return null;
          const isOpen = !closed[g];
          return (
            <Collapsible.Root key={g} open={isOpen} onOpenChange={(o) => setClosed((c) => { const n2 = { ...c }; if (o) delete n2[g]; else n2[g] = true; return n2; })} className="border-b border-line last:border-0">
              <Collapsible.Trigger className="w-full flex items-center gap-2 px-4.5 h-10 bg-subtle/70 text-[13px] font-semibold cursor-pointer hover:bg-subtle">
                <ChevronDown size={15} className={cn("transition-transform text-ink-3", !isOpen && "-rotate-90")} />{g}<span className="tnum font-normal text-ink-3">{gs.length}</span>
              </Collapsible.Trigger>
              <Collapsible.Content>
                {gs.map((x) => (
                  <div key={x.id} data-f={x.ev[0]?._i} onClick={() => x.ev[0] && ctx.setEvidence({ id: r.id, i: x.ev[0]._i })}
                    className="group grid grid-cols-[44px_minmax(0,1fr)] @3xl:grid-cols-[44px_minmax(0,1.3fr)_88px_minmax(0,1fr)_auto] gap-x-4 gap-y-2 px-4.5 py-3.5 border-t border-line cursor-pointer hover:bg-subtle/60">
                    <span className="tnum text-[12px] font-semibold text-ink-3 pt-0.5">{x.id}</span>
                    <div className="min-w-0"><div className="text-[13.5px] leading-snug">{x.text}{x.values && <span className="text-ink-3">, {x.values}</span>}</div><div className="mt-1.5 flex items-center gap-2"><Badge tone="outline">{x.must ? "Must" : "Scored"}</Badge><span className="@3xl:hidden"><StatusBadge s={x.status} /></span></div></div>
                    <div className="hidden @3xl:block"><StatusBadge s={x.status} /></div>
                    <div className="col-start-2 @3xl:col-start-auto text-[12.5px] text-ink-2 leading-snug">{x.reason}</div>
                    <div className="col-start-2 @3xl:col-start-auto"><Sources r={r} evs={x.ev} ctx={ctx} /></div>
                  </div>
                ))}
              </Collapsible.Content>
            </Collapsible.Root>
          );
        })}
        {!rows.length && <div className="py-12 text-center text-ink-3">No requirements match these filters.</div>}
      </Card>
      </>}
    </div>
  );
}

/* ---------------- Dates ---------------- */
function Dates({ rctx }) {
  const { r, ctx } = rctx;
  return (
    <div className="grid gap-5">
      <Card className="overflow-hidden">
        <CardHead title="Key dates" sub="Times as stated in the RFP" right={<Button size="sm" onClick={() => ctx.actions.icsFor(r.id)}><CalendarPlus size={14} />Add to calendar</Button>} />
        <ol>
          {!r.dates.length && <li className="px-4.5 py-8 text-center text-ink-3">No dates were stated.</li>}
          {r.dates.map((x, k) => (
            <li key={k} data-f={x.ev[0]?._i} onClick={() => x.ev[0] && ctx.setEvidence({ id: r.id, i: x.ev[0]._i })}
              className={cn("grid grid-cols-[96px_minmax(0,1fr)] @2xl:grid-cols-[150px_minmax(0,1fr)_auto] gap-x-5 gap-y-1 px-4.5 py-3.5 border-b border-line last:border-0", x.ev[0] && "cursor-pointer hover:bg-subtle/60")}>
              <div className="relative pl-4">
                <span className={cn("absolute left-0 top-1.5 w-2 h-2 rounded-full", x.mandatory ? "bg-nobid" : x.date ? "bg-[var(--c-date)]" : "bg-line-2")} />
                <div className="tnum font-semibold text-[13.5px]">{x.date ? fmtDate(x.date, { month: "short", day: "numeric" }) : <span className="text-ink-3 font-normal italic">Not stated</span>}</div>
                <div className="text-[12px] text-ink-3 tnum">{x.date ? toDate(x.date).getFullYear() : ""}{x.was && <span className="block line-through">{fmtShort(x.was)}</span>}</div>
              </div>
              <div className="min-w-0">
                <div className="font-medium text-[13.5px]">{x.label}</div>
                <div className="flex flex-wrap items-center gap-2 mt-1">
                  {x.time && <span className="text-[12.5px] text-ink-2 tnum">{x.time}</span>}
                  {x.mandatory && <Badge tone="nobid">Mandatory</Badge>}
                  {x.revisedBy && <Badge tone="info">Revised by {x.revisedBy}</Badge>}
                  {x.ambiguous && <Badge tone="warn">Check source</Badge>}
                  <Rel iso={x.date} />
                </div>
                {x.note && <div className="text-[12.5px] text-ink-3 mt-1">{x.note}</div>}
              </div>
              <div className="col-start-2 @2xl:col-start-auto"><Sources r={r} evs={x.ev} ctx={ctx} /></div>
            </li>
          ))}
        </ol>
      </Card>
      {r.addenda.map((a) => (
        <Card key={a.label} data-f={a.ev[0]?._i}>
          <CardHead title={a.label} sub={a.issued ? `Issued ${fmtDate(a.issued)}` : "Issue date not stated"} right={<div className="flex gap-1.5">{a.ack && <Badge tone="warn">Acknowledge in proposal</Badge>}{!a.confirmed && <Badge tone="neutral">Unconfirmed</Badge>}</div>} />
          <div className="p-4.5 text-[13.5px]">
            <p className="text-ink-2">{a.summary} <Sources r={r} evs={a.ev} ctx={ctx} /></p>
            {a.changes.map((c, j) => (
              <div key={j} className="mt-2.5 mr-2 inline-flex flex-wrap items-center gap-2 rounded-lg bg-subtle px-3 py-2">
                <span className="text-ink-3">{c.what}</span>{c.from && <span className="line-through text-ink-3 tnum">{c.from}</span>}{c.to && <><span aria-hidden="true">→</span><b className="tnum">{c.to}</b></>}
              </div>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}

/* ---------------- Fit ---------------- */
function Fit({ rctx }) {
  const { r } = rctx;
  const bid = r.decision === "BID";
  const total = r.fitFactors.reduce((n, f) => n + f.max, 0);
  const colors = ["var(--accent)", "var(--c-evaluation)", "var(--c-eligibility)", "var(--c-contract)", "var(--c-date)"];
  return (
    <Card>
      <CardHead title="Fit score against the idiaz.io profile" right={<span className="text-[22px] font-semibold tnum tracking-[-0.02em]">{r.fit}<span className="text-[14px] text-ink-3"> / 10</span></span>} />
      <div className="p-4.5">
        <div className="flex h-3 rounded-full overflow-hidden bg-muted" role="img" aria-label="Score composition">
          {r.fitFactors.map((f, i) => <Tip key={f.label} content={`${f.label}: ${f.points} of ${f.max}`}><span style={{ width: `${(f.points / total) * 100}%`, background: colors[i] }} className="border-r-2 border-surface last:border-0" /></Tip>)}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 mb-2 text-[12px] text-ink-2">{r.fitFactors.map((f, i) => <span key={f.label} className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm" style={{ background: colors[i] }} />{f.label}</span>)}</div>
        <div className="divide-y divide-line">
          {r.fitFactors.map((f, i) => (
            <div key={f.label} className="grid grid-cols-[minmax(0,1fr)_56px] @3xl:grid-cols-[200px_minmax(0,1fr)_56px] gap-x-5 gap-y-2 items-center py-4">
              <div className="font-medium text-[13.5px]">{f.label}</div>
              <div className="col-span-2 @3xl:col-span-1 row-start-2 @3xl:row-start-auto h-2 rounded-full bg-muted overflow-hidden"><motion.div className="h-full rounded-full" style={{ background: colors[i] }} initial={{ width: 0 }} animate={{ width: `${(f.points / f.max) * 100}%` }} transition={{ duration: 0.6, delay: i * 0.05 }} /></div>
              <div className="text-right tnum font-semibold text-[13.5px]">{f.points}<span className="text-ink-3 font-normal">/{f.max}</span></div>
              <p className="col-span-2 @3xl:col-span-3 text-[13px] text-ink-2 leading-relaxed">{f.reason}</p>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[12.5px] text-ink-3">{bid ? "We recommend bidding at 6/10 or above, when nothing blocks eligibility and the overall review agrees." : "Scores below 6/10, or any blocking requirement, mean no bid."}</p>
      </div>
    </Card>
  );
}

/* ---------------- Scoring & submission ---------------- */
function Scoring({ rctx }) {
  const { r, ctx } = rctx;
  const [sort, setSort] = useState({ k: "points", dir: -1 });
  const [done, setDone] = useState({});
  const crit = [...r.criteria].sort((a, b) => (sort.k === "points" ? (a.points ?? -1) - (b.points ?? -1) : a.name.localeCompare(b.name)) * sort.dir);
  const written = r.criteria.reduce((n, c) => n + (c.points ?? 0), 0);
  const max = Math.max(1, ...r.criteria.map((c) => c.points ?? 0));
  const pages = r.submission.reduce((n, s) => n + (s.limit || 0), 0);
  const ready = Object.values(done).filter(Boolean).length;
  const sortBy = (k) => setSort((s) => ({ k, dir: s.k === k ? -s.dir : k === "points" ? -1 : 1 }));
  return (
    <div className="grid gap-5">
      {r.criteria.length > 0 && (
        <Card className="overflow-hidden">
          <CardHead title="How proposals are scored" sub={written ? `${written} points in total` : "Weights not stated"} />
          <div className="overflow-x-auto"><table className="w-full text-[13.5px]">
            <thead className="bg-subtle/60 border-b border-line text-[12px] text-ink-3"><tr>
              <th className="text-left font-medium px-4.5 py-2.5"><button onClick={() => sortBy("name")} className="cursor-pointer hover:text-ink">Criterion</button></th>
              <th className="text-left font-medium px-4 py-2.5 hidden @2xl:table-cell w-[34%]">Weight</th>
              <th className="text-right font-medium px-4 py-2.5"><button onClick={() => sortBy("points")} className="cursor-pointer hover:text-ink">Points</button></th>
              <th className="px-4 py-2.5 w-px"><span className="sr-only">Source</span></th></tr></thead>
            <tbody>{crit.map((c) => (
              <tr key={c.name} data-f={c.ev[0]?._i} onClick={() => c.ev[0] && ctx.setEvidence({ id: r.id, i: c.ev[0]._i })} className="border-b border-line last:border-0 hover:bg-subtle/60 cursor-pointer align-top">
                <td className="px-4.5 py-3"><div className="font-medium">{c.name}</div>{c.note && <div className="text-[12.5px] text-ink-3 mt-0.5 max-w-[60ch]">{c.note}</div>}</td>
                <td className="px-4 py-3 hidden @2xl:table-cell"><div className="h-2 mt-1.5 rounded-full bg-muted overflow-hidden"><div className="h-full rounded-full bg-[var(--c-evaluation)]" style={{ width: `${((c.points ?? 0) / max) * 100}%` }} /></div></td>
                <td className="px-4 py-3 text-right tnum font-semibold">{c.points ?? <span className="text-ink-3 font-normal">n/a</span>}</td>
                <td className="px-4 py-3"><Sources r={r} evs={c.ev} ctx={ctx} /></td>
              </tr>
            ))}</tbody>
          </table></div>
          {r.award && <div data-f={r.award.ev[0]?._i} className="px-4.5 py-3.5 border-t border-line text-[13.5px] bg-subtle/40"><b>Award basis.</b> <span className="text-ink-2">{r.award.text}</span> <Sources r={r} evs={r.award.ev} ctx={ctx} /></div>}
        </Card>
      )}
      {!r.criteria.length && r.award && <Card className="p-4.5 text-[13.5px]"><b>Award basis.</b> <span className="text-ink-2">{r.award.text}</span> <Sources r={r} evs={r.award.ev} ctx={ctx} /></Card>}
      {r.submission.length > 0 && (
        <Card className="overflow-hidden">
          <CardHead title="Submission checklist" sub={`${ready} of ${r.submission.length} ready${pages ? `, page limits add up to ${pages} pages` : ""}`} right={<div className="w-28"><Meter value={ready} max={r.submission.length} /></div>} />
          <ul>{r.submission.map((s, k) => (
            <li key={k} data-f={s.ev[0]?._i} className="flex items-start gap-3 px-4.5 py-3 border-b border-line last:border-0">
              <Checkbox checked={!!done[k]} onCheckedChange={(v) => setDone((d) => ({ ...d, [k]: !!v }))} label={`Mark ${s.name} as ready`} />
              <div className="min-w-0 flex-1"><div className={cn("font-medium text-[13.5px]", done[k] && "line-through text-ink-3")}>{s.name}{!s.required && <Badge tone="neutral" className="ml-2">Optional</Badge>}</div>{s.note && <div className="text-[12.5px] text-ink-3 mt-0.5">{s.note}</div>}</div>
              {s.limit && <span className="tnum text-[11.5px] rounded bg-subtle px-1.5 py-0.5 text-ink-2 whitespace-nowrap">max {s.limit} pp</span>}
              <Sources r={r} evs={s.ev} ctx={ctx} />
            </li>
          ))}</ul>
        </Card>
      )}
    </div>
  );
}

/* ---------------- Contract ---------------- */
function Contract({ rctx }) {
  const { r, ctx } = rctx;
  return (
    <Card>
      <CardHead title="Contract terms" sub="What you agree to if you win" />
      <dl className="px-4.5 divide-y divide-line">
        {r.terms.map((t) => (
          <Row key={t.topic + t.text} f={t.ev[0]?._i} onOpen={t.ev[0] ? () => ctx.setEvidence({ id: r.id, i: t.ev[0]._i }) : null}>
            <dt className="text-[13px] font-medium @2xl:w-48 shrink-0">{t.topic}</dt>
            <dd className="text-[13.5px] text-ink-2 leading-relaxed min-w-0">{t.text} <Sources r={r} evs={t.ev} ctx={ctx} /></dd>
          </Row>
        ))}
      </dl>
    </Card>
  );
}

/* ---------------- Risks ---------------- */
function Risks({ rctx }) {
  const { r, ctx } = rctx;
  const copy = async () => {
    const body = `Subject: Questions on ${r.solicitation || r.title}\n\nHello,\n\nWe have the following questions about ${r.title}:\n\n${r.questions.map((x, i) => `${i + 1}. ${x}`).join("\n")}\n\nThank you.`;
    try { await navigator.clipboard.writeText(body); ctx.notify("Email draft copied to the clipboard.", false); } catch { ctx.notify("Copying isn't allowed in this browser.", false); }
  };
  return (
    <div className="grid gap-5">
      <Card className="overflow-hidden">
        <CardHead title="Deal-breakers" sub={r.dealBreakers.some((b) => b.severity === "blocking") ? "Any blocking item rules out a bid" : r.dealBreakers.length ? "Nothing blocks the bid, but these must be confirmed" : "Facts that would rule out a bid"} />
        {!r.dealBreakers.length && <div className="px-4.5 py-8 text-center text-ink-3">{r.degraded ? "Needs the full AI assessment. Use Retry." : "None found."}</div>}
        {r.dealBreakers.map((b, k) => (
          <div key={k} data-f={b.ev[0]?._i} onClick={() => b.ev[0] && ctx.setEvidence({ id: r.id, i: b.ev[0]._i })} className="flex items-start gap-3 px-4.5 py-3.5 border-b border-line last:border-0 cursor-pointer hover:bg-subtle/60">
            <Badge tone={b.severity === "blocking" ? "nobid" : "warn"} dot>{b.severity === "blocking" ? "Blocking" : "Verify"}</Badge>
            <span className="flex-1 text-[13.5px] leading-snug">{b.text}</span>
            <Sources r={r} evs={b.ev} ctx={ctx} />
          </div>
        ))}
      </Card>
      {r.ambiguities.length > 0 && (
        <Card className="overflow-hidden">
          <CardHead title="Unclear in the RFP" sub="Worth raising with the agency before you bid" />
          {r.ambiguities.map((a, k) => (
            <div key={k} data-f={a.ev[0]?._i} onClick={() => a.ev[0] && ctx.setEvidence({ id: r.id, i: a.ev[0]._i })} className="flex items-start gap-3 px-4.5 py-3.5 border-b border-line last:border-0 cursor-pointer hover:bg-subtle/60">
              <AlertTriangle size={15} className="text-warn shrink-0 mt-0.5" /><span className="flex-1 text-[13.5px] leading-snug">{a.text}</span><Sources r={r} evs={a.ev} ctx={ctx} />
            </div>
          ))}
        </Card>
      )}
      {r.questions.length > 0 && (
        <Card>
          <CardHead title="Questions to ask the agency" sub="Send before the written-questions deadline" right={<Button size="sm" onClick={copy}><Copy size={14} />Copy as email</Button>} />
          <ol className="p-4.5 grid gap-3">{r.questions.map((x, i) => <li key={i} className="flex gap-3 text-[13.5px] text-ink-2 leading-relaxed"><span className="tnum text-ink-3 font-semibold w-4">{i + 1}</span>{x}</li>)}</ol>
        </Card>
      )}
    </div>
  );
}
