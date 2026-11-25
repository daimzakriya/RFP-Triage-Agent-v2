import { useMemo, useState } from "react";
import { ArrowUpDown, CalendarPlus, MoreHorizontal, FileText, Search, Trash2, Flag, Diamond, ThumbsUp, Ban, AlarmClock, Send, FileUp, Download, Printer } from "lucide-react";
import { derive, daysTo, fmtDate, fmtShort, toDate, cn, today, shortId } from "../lib";
import { Button, Card, CardHead, Menu, MenuTrigger, MenuContent, MenuItem, MenuSep, Segmented, Tip } from "../ui";
import { Decision, Meter, Rel } from "../parts";

export default function Desk({ ctx }) {
  const [filter, setFilter] = useState("all");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState({ k: "rank", dir: 1 });
  const rows = useMemo(() => ctx.reports.map((r) => ({ r, d: derive(r) })), [ctx.reports]);
  const bids = rows.filter((x) => x.r.decision === "BID");
  const mand14 = rows.flatMap((x) => x.r.dates.filter((dt) => dt.mandatory && dt.date && daysTo(dt.date) >= 0 && daysTo(dt.date) <= 14).map((dt) => ({ dt, r: x.r }))).sort((a, b) => toDate(a.dt.date) - toDate(b.dt.date));
  const nextDue = rows.filter((x) => x.d.due?.date && daysTo(x.d.due.date) >= 0).sort((a, b) => toDate(a.d.due.date) - toDate(b.d.due.date))[0];

  const shown = rows
    .filter((x) => filter === "all" || (filter === "bid") === (x.r.decision === "BID"))
    .filter((x) => !q || `${x.r.title} ${x.r.agency} ${x.r.solicitation}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => {
      const v = (x) => ({ rank: rows.indexOf(x), fit: x.r.fit, due: x.d.due?.date ? toDate(x.d.due.date).getTime() : 9e15, title: x.r.title })[sort.k];
      return (v(a) > v(b) ? 1 : v(a) < v(b) ? -1 : 0) * sort.dir;
    });
  const sortBy = (k) => setSort((s) => ({ k, dir: s.k === k ? -s.dir : k === "fit" ? -1 : 1 }));
  const Th = ({ k, children, className }) => (
    <th className={cn("text-left font-medium text-[12px] text-ink-3 px-4 py-2.5 whitespace-nowrap", className)} aria-sort={sort.k === k ? (sort.dir > 0 ? "ascending" : "descending") : undefined}>
      {k ? <button onClick={() => sortBy(k)} className={cn("inline-flex items-center gap-1 cursor-pointer hover:text-ink", sort.k === k && "text-ink")}>{children}<ArrowUpDown size={12} /></button> : children}
    </th>
  );

  return (
    <div className="h-full overflow-y-auto scroll-thin">
      <div className="max-w-[1400px] mx-auto px-4 sm:px-8 py-8">
        <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
          <div>
            <h1 className="text-[22px] font-semibold tracking-[-0.02em]">Bid Desk</h1>
            <p className="text-ink-2 mt-1">{rows.length ? `${bids.length} of ${rows.length} RFP${rows.length > 1 ? "s are" : " is"} worth bidding.` : "Your triaged RFPs, ranked."} {!rows.length ? "" : mand14.length ? `${mand14.length} mandatory event${mand14.length > 1 ? "s" : ""} in the next two weeks.` : ""}</p>
          </div>
          {rows.length > 0 && <Button onClick={ctx.actions.icsAll}><CalendarPlus size={15} />Export bid deadlines</Button>}
        </div>

        {!rows.length ? (
          <div className="rounded-2xl border border-dashed border-line-2 bg-surface px-6 py-16 text-center">
            <div className="mx-auto w-12 h-12 rounded-xl grid place-items-center bg-hilite text-on-hilite mb-4"><FileUp size={22} /></div>
            <h2 className="text-[17px] font-semibold">No RFPs on the desk yet</h2>
            <p className="text-ink-3 mt-1 max-w-[46ch] mx-auto">Analyse an RFP and it lands here, ranked by whether to bid, fit score and the nearest deadline.</p>
            <Button variant="primary" className="mt-5" onClick={() => ctx.go("#analyze")}><FileUp size={15} />Analyse an RFP</Button>
          </div>
        ) : (<>
        <div className="grid grid-cols-2 lg:grid-cols-4 rounded-xl border border-line bg-surface shadow-card overflow-hidden mb-5">
          <Stat icon={ThumbsUp} chip="bg-bid-soft text-bid" label="Worth bidding" value={bids.length} tone="text-bid" sub={`of ${rows.length} analysed`} />
          <Stat icon={Ban} chip="bg-nobid-soft text-nobid" label="Not pursuing" value={rows.filter((x) => x.r.decision === "NO_BID").length} tone="text-nobid" sub={`${rows.filter((x) => x.r.fastNoBid).length} ruled out early`} />
          <Stat icon={AlarmClock} chip="bg-warn-soft text-warn" label="Mandatory, next 14 days" value={mand14.length} sub={mand14[0] ? `${mand14[0].dt.label}, ${fmtShort(mand14[0].dt.date)}` : "None"} />
          <Stat icon={Send} chip="bg-accent-soft text-accent" label="Next proposal due" value={nextDue ? fmtShort(nextDue.d.due.date) : "None"} sub={nextDue ? <Rel iso={nextDue.d.due.date} /> : ""} />
        </div>

        <Card className="mb-5">
          <CardHead title="Next 60 days" sub="Every dated event across your RFPs. Mandatory events are marked." right={<Legend />} />
          <Timeline rows={rows} ctx={ctx} />
        </Card>

        <Card>
          <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-line">
            <Segmented label="Filter by call" value={filter} onChange={setFilter} items={[{ value: "all", label: "All", count: rows.length }, { value: "bid", label: "Bid", count: bids.length }, { value: "nobid", label: "No bid", count: rows.length - bids.length }]} />
            <label className="relative ml-auto">
              <Search size={14} className="absolute left-2.5 top-2.5 text-ink-3" />
              <span className="sr-only">Filter RFPs</span>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by title or agency" className="h-8.5 w-64 max-w-full rounded-lg border border-line-2 bg-surface pl-8 pr-3 text-[13px] outline-none focus:border-accent focus:ring-3 focus:ring-accent-soft" />
            </label>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[13.5px] border-collapse">
              <thead className="bg-subtle/60 border-b border-line"><tr><Th k="rank" className="w-10">#</Th><Th k="title">RFP</Th><Th>Call</Th><Th k="fit">Fit</Th><Th className="hidden md:table-cell">Value</Th><Th k="due">Proposal due</Th><Th className="hidden xl:table-cell">Next mandatory event</Th><Th className="hidden md:table-cell">Next action</Th><Th className="w-10"><span className="sr-only">Actions</span></Th></tr></thead>
              <tbody>
                {shown.map(({ r, d }, i) => (
                  <tr key={r.id} onClick={() => ctx.go(`#report-${r.id}`)} className="border-b border-line last:border-0 hover:bg-subtle/60 cursor-pointer align-top">
                    <td className="px-4 py-3.5 tnum font-semibold text-ink-3">{i + 1}</td>
                    <td className="px-4 py-3.5 min-w-[260px]"><div className="font-semibold text-ink leading-snug">{r.title}</div>{r.agency && <div className="text-[12.5px] text-ink-3 mt-0.5">{r.agency}</div>}<div className="text-[12px] text-ink-3 tnum">{shortId(r)}</div></td>
                    <td className="px-4 py-3.5"><Decision r={r} /></td>
                    <td className="px-4 py-3.5">{r.degraded ? <span className="text-ink-3">Pending</span> : <div className="flex items-center gap-2.5"><span className="tnum font-semibold w-7 text-right">{r.fit}</span><Meter value={r.fit} tone={r.decision === "BID" ? "bid" : "nobid"} className="w-16" /></div>}</td>
                    <td className="px-4 py-3.5 hidden md:table-cell tnum">{d.value || <span className="text-ink-3">Not stated</span>}</td>
                    <td className="px-4 py-3.5 whitespace-nowrap"><div className="tnum">{fmtDate(d.due?.date)}</div><Rel iso={d.due?.date} /></td>
                    <td className="px-4 py-3.5 hidden xl:table-cell">{d.nextMandatory ? <><div>{d.nextMandatory.label}</div><div className="flex items-center gap-2 mt-0.5"><span className="text-[11.5px] font-semibold text-nobid">Mandatory</span><Rel iso={d.nextMandatory.date} /></div></> : <span className="text-ink-3">None</span>}</td>
                    <td className="px-4 py-3.5 hidden md:table-cell min-w-[190px]"><div>{d.nextAction.title}</div><div className="text-[12.5px] text-ink-3">{r.degraded ? "Retry the full analysis" : r.decision === "BID" ? `${d.verify} requirement${d.verify === 1 ? "" : "s"} to verify` : `${d.blocking} blocking deal-breaker${d.blocking === 1 ? "" : "s"}`}</div></td>
                    <td className="px-2 py-2.5" onClick={(e) => e.stopPropagation()}>
                      <Menu>
                        <MenuTrigger asChild><Button variant="ghost" size="icon" aria-label={`Actions for ${r.title}`}><MoreHorizontal size={16} /></Button></MenuTrigger>
                        <MenuContent>
                          <MenuItem onSelect={() => ctx.go(`#report-${r.id}`)}><FileText size={15} />Open report</MenuItem>
                          <MenuItem onSelect={() => { ctx.go(`#report-${r.id}`); setTimeout(() => ctx.setEvidence({ id: r.id, page: 1 }), 30); }}><Search size={15} />Open source PDF</MenuItem>
                          <MenuItem onSelect={() => ctx.actions.icsFor(r.id)}><CalendarPlus size={15} />Add deadlines to calendar</MenuItem>
                          <MenuItem onSelect={() => ctx.actions.json(r.id)}><Download size={15} />Download JSON</MenuItem>
                          <MenuSep />
                          <MenuItem onSelect={() => ctx.actions.remove(r.id)} className="text-nobid data-[highlighted]:text-nobid"><Trash2 size={15} />Remove from desk</MenuItem>
                        </MenuContent>
                      </Menu>
                    </td>
                  </tr>
                ))}
                {!shown.length && rows.length > 0 && <tr><td colSpan={9} className="py-12 text-center text-ink-3">No RFPs match these filters.</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>
        </>)}
      </div>
    </div>
  );
}

function Stat({ icon: Icon, chip, label, value, sub, tone }) {
  return (
    <div className="px-5 py-4 border-line [&:not(:last-child)]:border-r max-lg:[&:nth-child(2)]:border-r-0 max-lg:[&:nth-child(-n+2)]:border-b min-w-0">
      <div className="flex items-center gap-2 text-[12.5px] text-ink-3"><span className={cn("w-6 h-6 rounded-md grid place-items-center", chip)}><Icon size={13} /></span>{label}</div>
      <div className={cn("text-[24px] font-semibold tracking-[-0.02em] tnum mt-0.5", tone)}>{value}</div>
      <div className="text-[12.5px] text-ink-2 truncate">{sub}</div>
    </div>
  );
}

const Legend = () => (
  <div className="hidden sm:flex items-center gap-4 text-[12px] text-ink-3">
    <span className="inline-flex items-center gap-1.5"><Flag size={13} className="text-accent fill-hilite" />Proposal due</span>
    <span className="inline-flex items-center gap-1.5"><Diamond size={12} className="text-nobid fill-nobid" />Mandatory</span>
    <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-ink-3" />Other</span>
  </div>
);

/* Horizontal deadline timeline across all RFPs, events labelled in place */
function Timeline({ rows, ctx }) {
  const SPAN = 60;
  const ticks = [0, 7, 14, 21, 28, 35, 42, 49, 56];
  const pos = (iso) => (daysTo(iso) / SPAN) * 100;
  return (
    <div className="px-4 sm:px-5 pt-4 pb-3 overflow-x-auto">
      <div className="min-w-[760px]">
        <div className="relative h-6 ml-[220px] text-[11.5px] text-ink-3 tnum">
          {ticks.map((t) => { const dt = today(); dt.setDate(dt.getDate() + t); return <span key={t} className={cn("absolute -translate-x-1/2", t === 0 && "text-ink font-semibold")} style={{ left: `${(t / SPAN) * 100}%` }}>{t === 0 ? "Today" : dt.toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>; })}
        </div>
        {rows.map(({ r }) => {
          const evs = r.dates.filter((d) => d.date && daysTo(d.date) >= 0 && daysTo(d.date) <= SPAN);
          const bid = r.decision === "BID";
          return (
            <div key={r.id} className="flex items-stretch h-[84px] border-t border-line">
              <button onClick={() => ctx.go(`#report-${r.id}`)} className="w-[220px] shrink-0 pr-4 py-3 text-left cursor-pointer group">
                <div className="text-[13px] font-medium leading-snug line-clamp-2 group-hover:underline decoration-hilite decoration-2 underline-offset-2">{r.title}</div>
                <div className="mt-1 flex items-center gap-1.5 text-[11.5px] text-ink-3"><span className={cn("w-1.5 h-1.5 rounded-full", bid ? "bg-bid" : "bg-nobid")} />{bid ? "Bid" : "No bid"}, fit {r.fit}</div>
              </button>
              <div className="relative flex-1">
                {ticks.map((t) => <span key={t} className={cn("absolute top-0 bottom-0", t === 0 ? "w-[2px] bg-hilite" : "w-px bg-line")} style={{ left: `${(t / SPAN) * 100}%` }} />)}
                <span className="absolute top-[34px] h-px left-0 right-0 bg-line-2" />
                {evs.map((d, k) => {
                  const isDue = d.kind === "proposal";
                  const strong = isDue || d.mandatory;
                  return (
                    <Tip key={k} content={<span><b>{d.label}</b><br />{fmtDate(d.date)}{d.time ? `, ${d.time}` : ""}{d.mandatory ? ", mandatory" : ""}</span>}>
                      <button onClick={() => { ctx.go(`#report-${r.id}--dates`); }} aria-label={`${d.label}, ${fmtDate(d.date)}`}
                        className={cn("absolute top-[34px] -translate-x-1/2 -translate-y-1/2 flex flex-col items-center cursor-pointer group", !bid && "opacity-75")} style={{ left: `${pos(d.date)}%` }}>
                        <span className="h-5 grid place-items-center transition-transform group-hover:scale-125">
                          {isDue ? <Flag size={17} className="text-accent fill-hilite" strokeWidth={2.2} /> : d.mandatory ? <Diamond size={14} className="text-nobid fill-nobid" /> : <span className="w-2.5 h-2.5 rounded-full bg-ink-3 ring-3 ring-surface" />}
                        </span>
                        {strong && <span className={cn("absolute top-[26px] whitespace-nowrap text-[11px] leading-tight max-w-[112px] truncate px-1 rounded", isDue ? "font-semibold text-ink bg-accent-soft" : "text-nobid")}>{isDue ? "Proposal due" : d.label.replace(/^Mandatory /i, "")}</span>}
                      </button>
                    </Tip>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
