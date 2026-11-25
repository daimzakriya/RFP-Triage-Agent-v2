import { FileUp, LayoutList, Trash2, Sun, Moon, PanelLeftClose, PanelLeftOpen, Clock, X } from "lucide-react";
import { cn, derive, relText, urgency, shortId } from "./lib";
import { Tip } from "./ui";

/* The sidebar is a bid pipeline, not a link list: each RFP shows its call, fit and countdown,
   and the next deadlines across every RFP sit underneath. Ink in both themes. */
export default function Sidebar({ reports, route, go, onRemove, job, queued, dark, setDark, collapsed, setCollapsed, mobile, onClose }) {
  const items = reports.map((r) => ({ r, d: derive(r) }));
  const groups = [
    ["Bidding", items.filter((x) => x.r.decision === "BID")],
    ["No call yet", items.filter((x) => x.r.decision === "UNDETERMINED")],
    ["Not pursuing", items.filter((x) => x.r.decision === "NO_BID")],
  ];
  const c = collapsed && !mobile;

  return (
    <div className="h-full flex flex-col bg-side text-side-ink relative overflow-hidden">
      {/* brand */}
      <div className={cn("relative flex items-center h-14 shrink-0", c ? "justify-center px-0" : "px-4 gap-2.5")}>
        <Mark />
        {!c && <div className="leading-tight min-w-0"><div className="font-bold text-[15.5px] tracking-[-0.02em]">Wyn<span className="text-[#c6f432]">Bid</span></div><div className="text-[11.5px] text-side-ink-3">Bid workspace</div></div>}
        {!c && (mobile
          ? <button onClick={onClose} aria-label="Close navigation" className="ml-auto p-1.5 rounded-md text-side-ink-2 hover:bg-side-2 cursor-pointer"><X size={17} /></button>
          : <Tip content="Collapse sidebar"><button onClick={() => setCollapsed(true)} aria-label="Collapse sidebar" className="ml-auto p-1.5 rounded-md text-side-ink-3 hover:text-side-ink hover:bg-side-2 cursor-pointer"><PanelLeftClose size={16} /></button></Tip>)}
      </div>

      <nav className={cn("relative mt-1 flex flex-col gap-0.5", c ? "px-2.5" : "px-3")} aria-label="Main">
        <Item c={c} icon={FileUp} label="New analysis" hint="N" active={route.view === "analyze"} onClick={() => go("#analyze")} />
        <Item c={c} icon={LayoutList} label="Bid Desk" hint="D" active={route.view === "desk"} onClick={() => go("#desk")} />
      </nav>

      <div className={cn("relative flex-1 min-h-0 overflow-y-auto overflow-x-hidden no-scrollbar mt-4", c ? "px-2.5" : "px-3")}>
        {!c && !reports.length && <p className="px-2 text-[12.5px] leading-snug text-side-ink-3">Analysed RFPs appear here with their call, fit score and next deadline.</p>}
        {groups.map(([label, list]) => list.length > 0 && (
          <div key={label} className="mb-4">
            {!c && <div className="flex items-center justify-between px-2 mb-1.5 text-[11.5px] text-side-ink-3"><span className="font-medium">{label}</span><span className="tnum">{list.length}</span></div>}
            <div className="flex flex-col gap-1">
              {list.map(({ r, d }) => {
                const active = route.view === "report" && route.id === r.id;
                const bid = r.decision === "BID";
                const tone = r.degraded ? "var(--warn)" : bid ? "var(--bid)" : "var(--nobid)";
                const fit = r.degraded ? "–" : r.fit;
                const due = d.due?.date;
                if (c) return (
                  <Tip key={r.id} side="right" content={<span><b>{r.title}</b><br />{r.degraded ? "No call yet" : bid ? "Bid" : "No bid"}, fit {fit}{due ? `, due ${relText(due)}` : ""}</span>}>
                    <button onClick={() => go(`#report-${r.id}`)} aria-label={r.title} className={cn("relative h-10 grid place-items-center rounded-lg cursor-pointer tnum text-[12.5px] font-semibold", active ? "bg-side-3 text-side-ink" : "text-side-ink-2 hover:bg-side-2")}>
                      <span className="absolute left-1 top-2 bottom-2 w-[3px] rounded-full" style={{ background: tone }} />{fit}
                    </button>
                  </Tip>
                );
                return (
                  <div key={r.id} className="group/item relative">
                  <button onClick={() => go(`#report-${r.id}`)} aria-current={active ? "page" : undefined}
                    className={cn("group relative w-full text-left rounded-xl pl-3.5 pr-8 py-2.5 cursor-pointer transition-colors", active ? "bg-side-3" : "hover:bg-side-2")}>
                    <span className="absolute left-1.5 top-3 bottom-3 w-[3px] rounded-full" style={{ background: tone }} />
                    <span className="block text-[13px] font-medium leading-snug line-clamp-2 text-side-ink">{r.title}</span>
                    <span className="mt-1.5 flex items-center gap-2 text-[11.5px]">
                      <span className="tnum font-semibold px-1.5 rounded-md" style={{ color: tone, background: `color-mix(in srgb, ${tone} 15%, transparent)` }}>{fit}</span>
                      <span className="tnum text-side-ink-3 truncate">{shortId(r)}</span>
                      {due && <span className={cn("ml-auto inline-flex items-center gap-1 tnum shrink-0", urgency(due) === "urgent" ? "text-[var(--nobid)]" : urgency(due) === "soon" ? "text-hilite" : "text-side-ink-3")}><Clock size={11} />{relText(due).replace("in ", "")}</span>}
                    </span>
                  </button>
                  <button onClick={() => onRemove(r.id)} aria-label={`Remove ${r.title} from the desk`} title="Remove from desk"
                    className="absolute right-1.5 top-2 p-1 rounded-md text-side-ink-3 hover:text-[var(--nobid)] hover:bg-side-2 cursor-pointer opacity-0 group-hover/item:opacity-100 focus-visible:opacity-100 max-lg:opacity-100 transition-opacity"><Trash2 size={13} /></button>
                  </div>
                );
              })}
            </div>
          </div>
        ))}

      </div>

      <div className={cn("relative shrink-0 border-t border-side-line", c ? "p-2.5 grid gap-2" : "p-3")}>
        {c ? (<>
          <Tip content={dark ? "Light theme" : "Dark theme"} side="right"><button onClick={() => setDark(!dark)} aria-label="Switch theme" className="h-9 grid place-items-center rounded-lg text-side-ink-2 hover:bg-side-2 cursor-pointer">{dark ? <Sun size={16} /> : <Moon size={16} />}</button></Tip>
          <Tip content="Expand sidebar" side="right"><button onClick={() => setCollapsed(false)} aria-label="Expand sidebar" className="h-9 grid place-items-center rounded-lg text-side-ink-2 hover:bg-side-2 cursor-pointer"><PanelLeftOpen size={16} /></button></Tip>
        </>) : (<>
          <div className="grid grid-cols-2 p-0.5 rounded-lg bg-side-2 border border-side-line" role="group" aria-label="Theme">
            <button onClick={() => setDark(false)} aria-pressed={!dark} className={cn("h-7 rounded-md text-[12.5px] inline-flex items-center justify-center gap-1.5 cursor-pointer", !dark ? "bg-side-3 text-side-ink" : "text-side-ink-3 hover:text-side-ink-2")}><Sun size={13} />Light</button>
            <button onClick={() => setDark(true)} aria-pressed={dark} className={cn("h-7 rounded-md text-[12.5px] inline-flex items-center justify-center gap-1.5 cursor-pointer", dark ? "bg-side-3 text-side-ink" : "text-side-ink-3 hover:text-side-ink-2")}><Moon size={13} />Dark</button>
          </div>
          <p className="mt-2.5 px-1 flex items-center gap-2 text-[11.5px] leading-snug text-side-ink-3"><span className={cn("w-1.5 h-1.5 rounded-full", job ? "bg-hilite animate-pulse" : "bg-[var(--bid)]")} />{job ? `Analysing ${job.name}${queued ? `, ${queued} waiting` : ""}` : "Ready for the next RFP"}</p>
        </>)}
      </div>
    </div>
  );
}

function Item({ c, icon: Icon, label, hint, active, onClick }) {
  const btn = (
    <button onClick={onClick} aria-current={active ? "page" : undefined} aria-label={c ? label : undefined}
      className={cn("group relative flex items-center gap-2.5 h-9 rounded-lg text-[13.5px] w-full cursor-pointer transition-colors", c ? "justify-center" : "px-2.5",
        active ? "bg-side-3 text-side-ink font-medium" : "text-side-ink-2 hover:bg-side-2 hover:text-side-ink")}>
      <Icon size={16} className={active ? "text-hilite" : ""} />
      {!c && <>{label}<span className="ml-auto text-[11px] border border-side-line rounded px-1.5 text-side-ink-3 opacity-0 group-hover:opacity-100 transition-opacity">{hint}</span></>}
    </button>
  );
  return c ? <Tip content={`${label} (${hint})`} side="right">{btn}</Tip> : btn;
}

/* WynBid mark: a rising "W" on a navy tile. */
function Mark() {
  return (
    <svg width={30} height={30} viewBox="0 0 360 360" aria-hidden="true" className="shrink-0">
      <rect width="360" height="360" rx="96" fill="#0b1b3f" />
      <rect x="16" y="16" width="328" height="328" rx="80" fill="none" stroke="#24376a" strokeWidth="11" />
      <path d="M78 120 L121 250 L180 155 L229 243 L284 110" fill="none" stroke="#c6f432" strokeWidth="27" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M228 96 H293 V145" fill="none" stroke="#c6f432" strokeWidth="27" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
