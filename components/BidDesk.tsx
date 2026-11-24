"use client";

import { formatIsoShort } from "@/lib/dates";
import { Icon } from "./Icon";
import { nextAction, proposalDue, rankDesk, type DeskItem } from "@/lib/desk";
import { DaysLeft } from "./Report";

export function BidDesk({
  items,
  selectedId,
  onSelect,
  onRemove,
  onExportAll,
}: {
  items: DeskItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  onExportAll: () => void;
}) {
  const ranked = rankDesk(items);
  const bids = items.filter((i) => i.report.decision === "BID").length;

  return (
    <section className="card desk-card" aria-labelledby="desk-h">
      <div className="card-head">
        <div>
          <div className="label"><Icon name="desk" size={13} /> Bonus feature · Bid Desk</div>
          <h2 id="desk-h">What to work on first</h2>
        </div>
        {items.length > 0 && (
          <button className="btn btn-sm" onClick={onExportAll} title="Calendar file with every dated deadline for the RFPs marked BID">
            <Icon name="calendar" /> Calendar for all BIDs
          </button>
        )}
      </div>

      {items.length === 0 ? (
        <div className="empty">
          Triaged RFPs collect here, ranked by decision, fit and how soon they're due.
          <br />Drop in several PDFs at once to compare them.
        </div>
      ) : (
        <>
          <p className="small muted" style={{ marginTop: -4 }}>
            {items.length} RFP{items.length > 1 ? "s" : ""} triaged · {bids} worth bidding · saved in this browser only
          </p>
          <div className="table-wrap">
            <table className="desk">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">RFP</th>
                  <th scope="col">Call</th>
                  <th scope="col">Proposal due</th>
                  <th scope="col">Next action</th>
                  <th scope="col"><span className="sr-only">Remove</span></th>
                </tr>
              </thead>
              <tbody>
                {ranked.map((it, i) => {
                  const r = it.report;
                  const due = proposalDue(r);
                  const next = nextAction(r);
                  return (
                    <tr key={it.id} className={it.id === selectedId ? "selected" : ""}>
                      <td className="rank">{i + 1}</td>
                      <td>
                        <button className="title-btn" onClick={() => onSelect(it.id)} aria-current={it.id === selectedId}>
                          {r.title}
                        </button>
                        <div className="small muted">{r.solicitation_number}</div>
                      </td>
                      <td>
                        <span className={`chip ${r.decision === "BID" ? "chip-bid" : r.decision === "NO_BID" ? "chip-nobid" : "chip-neutral"}`}>
                          {r.decision === "BID" ? "BID" : r.decision === "NO_BID" ? "NO BID" : "NO CALL"}
                        </span>
                        <div className="days" style={{ marginTop: 4 }}>{r.degraded ? "AI pending" : `${r.fit_score}/10`}</div>
                      </td>
                      <td>
                        {due ? (
                          <>
                            <div className="small">{formatIsoShort(due.date)}</div>
                            <DaysLeft iso={due.date} />
                          </>
                        ) : (
                          <span className="not-stated small">Not stated</span>
                        )}
                      </td>
                      <td>
                        {next ? (
                          <>
                            <div className="small">
                              {next.label}
                              {next.mandatory && <> <span className="chip chip-nobid">mandatory</span></>}
                            </div>
                            <DaysLeft iso={next.date} />
                          </>
                        ) : (
                          <span className="small muted">Nothing upcoming</span>
                        )}
                      </td>
                      <td>
                        <button className="btn btn-ghost btn-sm" onClick={() => onRemove(it.id)} aria-label={`Remove ${r.title}`}>
                          <Icon name="x" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
