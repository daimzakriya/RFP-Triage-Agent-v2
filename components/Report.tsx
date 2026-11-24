"use client";

import { useMemo, useState } from "react";
import { daysUntil, formatIsoLong } from "@/lib/dates";
import type { Requirement, TriageReport } from "@/lib/schema";
import { collectFindings } from "@/lib/evidence-map";
import { CategoryContext, EvidenceList } from "./Evidence";
import { Icon } from "./Icon";
import { Legend } from "./PdfEvidenceViewer";

/** Circular fit gauge (0–10). */
function Ring({ value, tone }: { value: number; tone: "bid" | "nobid" | "pending" }) {
  const r = 52;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(10, value)) / 10;
  return (
    <svg className={`ring ${tone}`} viewBox="0 0 120 120" width="132" height="132" aria-hidden="true">
      <circle cx="60" cy="60" r={r} className="ring-track" />
      <circle cx="60" cy="60" r={r} className="ring-val" strokeDasharray={c} strokeDashoffset={c * (1 - pct)} transform="rotate(-90 60 60)" />
    </svg>
  );
}

function Kpi({ icon, label, value, sub, tone }: { icon: string; label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: string }) {
  return (
    <div className={`kpi ${tone ?? ""}`}>
      <div className="kpi-head"><Icon name={icon} size={14} /> {label}</div>
      <div className="kpi-val">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

const FACT_LABELS: Record<keyof TriageReport["facts"], string> = {
  agency: "Agency",
  scope: "Scope of work",
  contract_type: "Contract type",
  contract_value: "Contract value",
  work_location: "Work location",
  period_of_performance: "Contract term",
  submission_method: "How to submit",
};

const REQ_LABELS: Record<Requirement["category"], string> = {
  set_aside: "Set-asides & preferences",
  past_performance: "Experience & past performance",
  certification: "Certifications",
  security_clearance: "Security clearances & background checks",
  registration: "Registrations",
  staffing: "Staffing & key personnel",
  skill: "Required skills & capabilities",
  technical: "Technical mandates",
  security_privacy: "Security, hosting & data",
  accessibility: "Accessibility & language access",
  insurance_bonding: "Insurance & bonding",
  contract_terms: "Contract obligations",
  other: "Other",
};

const COMPLIANCE: Record<string, { label: string; cls: string; tip: string }> = {
  compliant: { label: "meets", cls: "chip-bid", tip: "idiaz.io's profile clearly satisfies this" },
  non_compliant: { label: "can't meet", cls: "chip-nobid", tip: "idiaz.io's profile clearly cannot satisfy this" },
  partial: { label: "partly", cls: "chip-warn", tip: "Partly satisfied; part unknown or not met" },
  unknown: { label: "unknown", cls: "chip-neutral", tip: "The profile says nothing about this; confirm with the team" },
  verify: { label: "verify", cls: "chip-warn", tip: "Plausible, but needs confirmation before bidding" },
};

const QC_ICON = { pass: "✓", warn: "!", fail: "✕" } as const;
const REQ_ORDER = Object.keys(REQ_LABELS) as Requirement["category"][];

export function DaysLeft({ iso }: { iso: string }) {
  const n = daysUntil(iso);
  const cls = n < 0 ? "" : n <= 7 ? "urgent" : n <= 21 ? "soon" : "";
  const txt = n < 0 ? `${-n}d ago` : n === 0 ? "today" : `in ${n}d`;
  return <span className={`days ${cls}`}>{txt}</span>;
}

function StatusChip({ status, needsReview }: { status: string; needsReview?: boolean }) {
  if (status === "ambiguous") return <span className="chip chip-warn">ambiguous</span>;
  if (needsReview) return <span className="chip chip-warn">check source</span>;
  return null;
}

export function Report({
  report,
  onDownloadIcs,
  onRetry,
  retrying,
}: {
  report: TriageReport;
  onDownloadIcs: () => void;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const r = report;
  const bid = r.decision === "BID";
  const [copied, setCopied] = useState(false);
  const warnings = r.review_flags.filter((f) => f.level === "warning");
  const infos = r.review_flags.filter((f) => f.level === "info");

  const proposal = r.deadlines.find((d) => d.kind === "proposal_due");
  const musts = r.requirements.filter((q) => q.mandatory);
  const money = r.facts.contract_value.status === "not_stated" ? null : (/\$\s?[\d,.]+(?:\s?(?:million|billion|[MK]))?/i.exec(r.facts.contract_value.value)?.[0] ?? null);
  const blocking = r.deal_breakers.filter((d) => d.severity === "blocking").length;
  const categories = useMemo(() => new Map(collectFindings(r).map((f) => [f.key, f.category])), [r]);
  const grouped = REQ_ORDER.map((cat) => ({ cat, items: r.requirements.filter((q) => q.category === cat) })).filter((g) => g.items.length);

  function copyQuestions() {
    const text = `Subject: ${r.solicitation_number || r.title}: Questions\n\nHello,\n\nWe have the following questions about ${r.solicitation_number ? `RFP ${r.solicitation_number}` : "this solicitation"}:\n\n${r.open_questions
      .map((q, i) => `${i + 1}. ${q}`)
      .join("\n")}\n\nThank you,\n`;
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => {},
    );
  }

  return (
    <CategoryContext.Provider value={categories}>
    <div>
      {/* ---------- decision ---------- */}
      <section className="card hero-card" id="sec-verdict" aria-labelledby="decision-h">
        <div className="hero">
          <div className={`verdict ${r.degraded ? "pending" : bid ? "bid" : "nobid"}`}>
            <div className="label" style={{ color: "inherit" }}>Recommendation</div>
            <div className="verdict-ring">
              <Ring value={r.degraded ? 0 : r.fit_score} tone={r.degraded ? "pending" : bid ? "bid" : "nobid"} />
              <div className="verdict-center">
                {r.degraded ? <span className="ring-na">—</span> : <><b>{r.fit_score}</b><span>/10 fit</span></>}
              </div>
            </div>
            <div className="word" id="decision-h">{r.degraded ? "NO CALL YET" : bid ? "BID" : "NO BID"}</div>
            {r.degraded && (
              <>
                <p className="small" style={{ margin: "0 0 10px" }}>
                  The free AI models were busy, so this is a text-search report without a fit score.
                </p>
                {onRetry && (
                  <button className="btn btn-primary btn-sm no-print" onClick={onRetry} disabled={retrying}>
                    <Icon name="refresh" /> {retrying ? "Retrying…" : "Retry full analysis"}
                  </button>
                )}
              </>
            )}
            {r.fastNoBid && <div style={{ marginTop: 10 }}><span className="chip chip-nobid"><Icon name="zap" size={12} /> fast no-bid</span></div>}
          </div>
          <div className="hero-main">
            <div className="label hero-meta">
              {r.solicitation_number || "No solicitation number"}
              {r.facts.agency.status !== "not_stated" && <> · {r.facts.agency.value}</>}
            </div>
            <h2 className="hero-title">{r.title}</h2>
            {r.decisionNote && <div className="alert alert-info" style={{ margin: "10px 0" }}>{r.decisionNote}</div>}
            <div className="kpis">
              <Kpi
                icon="calendar"
                label="Proposal due"
                value={proposal?.date ? formatIsoLong(proposal.date) : "Not stated"}
                sub={proposal?.date ? <DaysLeft iso={proposal.date} /> : undefined}
              />
              <Kpi
                icon="coins"
                label="Contract value"
                value={money ?? (r.facts.contract_value.status === "not_stated" ? "Not stated" : "See summary")}
                sub={money && r.facts.contract_value.value.length > money.length + 4 ? <span title={r.facts.contract_value.value}>{/not[- ]to[- ]exceed|cap|max/i.test(r.facts.contract_value.value) ? "ceiling · details in summary" : "details in summary"}</span> : undefined}
              />
              <Kpi
                icon="checks"
                label="Must-haves"
                value={musts.length}
                sub={<>{musts.filter((q) => q.compliance === "compliant").length} met · {musts.filter((q) => q.compliance === "verify" || q.compliance === "partial" || q.compliance === "unknown").length} to verify</>}
              />
              <Kpi
                icon="alert"
                label="Deal-breakers"
                value={r.deal_breakers.length}
                tone={blocking > 0 ? "bad" : r.deal_breakers.length ? "warn" : "good"}
                sub={blocking > 0 ? `${blocking} blocking` : r.deal_breakers.length ? "verify only" : "none found"}
              />
              <Kpi
                icon="shield"
                label="Evidence"
                value={<>{r.evidence_stats.verified}<small>/{r.evidence_stats.total}</small></>}
                sub="quotes found word for word"
                tone={r.evidence_stats.unverified ? "warn" : "good"}
              />
            </div>
          </div>
        </div>
        {(r.reasons.length > 0 || r.change_mind.length > 0) && (
          <div className="hero-reasons">
            {r.reasons.length > 0 && (
              <div>
                <h3><Icon name="sparkles" size={15} /> Three strongest reasons</h3>
                <ol className="reasons">{r.reasons.map((x, i) => <li key={i}>{x}</li>)}</ol>
              </div>
            )}
            {r.change_mind.length > 0 && (
              <div>
                <h3><Icon name="refresh" size={15} /> What would change our mind</h3>
                <ul className="reasons">{r.change_mind.map((x, i) => <li key={i}>{x}</li>)}</ul>
              </div>
            )}
          </div>
        )}
      </section>

      {/* ---------- review flags ---------- */}
      <section className="card trust" aria-labelledby="review-h">
        <div className="card-head">
          <h2 id="review-h">
            <Icon name="shield" size={18} /> Check before you trust it{" "}
            {r.quality && (
              <span className={`chip ${r.quality.status === "verified" ? "chip-bid" : r.quality.status === "needs_review" ? "chip-warn" : "chip-nobid"}`}>
                {r.quality.status === "verified" ? "all checks passed" : r.quality.status === "needs_review" ? "needs review" : "incomplete"}
              </span>
            )}
          </h2>
          <span className="small muted">
            {r.evidence_stats.verified}/{r.evidence_stats.total} source quotes found word for word
            {r.evidence_stats.unverified > 0 && <> · <b style={{ color: "var(--nobid)" }}>{r.evidence_stats.unverified} not found</b></>}
          </span>
        </div>
        {r.quality && (
          <details style={{ marginBottom: 10 }} open={r.quality.status !== "verified"}>
            <summary className="small" style={{ cursor: "pointer" }}>
              Quality checks: {r.quality.checks.filter((c) => c.status === "pass").length}/{r.quality.checks.length} passed
            </summary>
            <ul className="qc">
              {r.quality.checks.map((c) => (
                <li key={c.id} className={`qc-${c.status}`}>
                  <span aria-hidden="true">{QC_ICON[c.status]}</span>
                  <span>
                    <strong>{c.label}</strong> <span className="muted">· {c.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
        <div className="hl-hint no-print">
          <p className="small" style={{ margin: "0 0 6px" }}>
            <b>See it in the PDF:</b> click any <span className="ev-btn verified" aria-hidden="true">p.5 ✓</span> badge to open the original page with the passage highlighted. Colours:
          </p>
          <Legend compact />
        </div>
        {r.review_flags.length === 0 ? (
          <p className="small muted" style={{ margin: 0 }}>No conflicts, ambiguities or unverified quotes were found.</p>
        ) : (
          <ul className="flags">
            {[...warnings, ...infos].map((f, i) => (
              <li key={i} className={`alert ${f.level === "warning" ? "alert-warn" : "alert-info"}`}>
                <span aria-hidden="true">{f.level === "warning" ? "⚠" : "ℹ"}</span>
                <span>{f.message}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="grid-2" style={{ marginTop: 16 }}>
        <div>
          {/* ---------- summary & facts ---------- */}
          <section className="card" id="sec-summary" aria-labelledby="summary-h">
            <div className="label"><span className="num">01</span><Icon name="summary" size={13} /> Summary</div>
            <h2 id="summary-h" className="sr-only">Summary</h2>
            <p style={{ marginTop: 6 }}>{r.summary}</p>
            <div className="kv" style={{ marginTop: 8 }}>
              {(Object.keys(FACT_LABELS) as (keyof typeof FACT_LABELS)[]).map((k) => {
                const f = r.facts[k];
                return (
                  <div key={k} style={{ display: "contents" }}>
                    <div className="k">{FACT_LABELS[k]}</div>
                    <div className={f.needsReview ? "review" : ""}>
                      {f.status === "not_stated" ? <span className="not-stated">Not stated</span> : f.value}{" "}
                      <StatusChip status={f.status} needsReview={f.needsReview} />
                      <EvidenceList evidence={f.evidence} />
                      {f.note && <div className="note">{f.note}</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* ---------- requirements ---------- */}
          <section className="card" id="sec-requirements" aria-labelledby="req-h">
            <div className="label"><span className="num">02</span><Icon name="checks" size={13} /> Requirements</div>
            <h2 id="req-h" className="sr-only">Requirements</h2>
            {grouped.length === 0 && <p className="not-stated">No requirements stated.</p>}
            {grouped.map((g) => (
              <div className="req-group" key={g.cat}>
                <h3 style={{ marginTop: 10 }}>{REQ_LABELS[g.cat]}</h3>
                <ul className="req-list">
                  {g.items.map((q, i) => (
                    <li key={i} className={q.needsReview ? "review" : ""}>
                      {q.id && <span className="req-id">{q.id}</span>}
                      <span className={`chip ${q.mandatory ? "chip-accent" : "chip-neutral"}`} style={{ marginRight: 6 }}>
                        {q.mandatory ? "must" : "scored"}
                      </span>
                      {q.text}
                      {q.values && !q.text.includes(q.values) && <span className="muted"> · {q.values}</span>}
                      <EvidenceList evidence={q.evidence} />
                      {q.compliance && (
                        <div className="small" style={{ marginTop: 4 }}>
                          <span className={`chip ${COMPLIANCE[q.compliance].cls}`} title={COMPLIANCE[q.compliance].tip}>
                            {COMPLIANCE[q.compliance].label}
                          </span>{" "}
                          <span className="muted">{q.compliance_reason}</span>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        </div>

        <div>
          {/* ---------- dates ---------- */}
          <section className="card" id="sec-dates" aria-labelledby="dates-h">
            <div className="card-head">
              <div className="label"><span className="num">03</span><Icon name="calendar" size={13} /> Key dates</div>
              <button className="btn btn-sm no-print" onClick={onDownloadIcs}><Icon name="plus" /> Add to calendar</button>
            </div>
            <h2 id="dates-h" className="sr-only">Key dates</h2>
            <ol className="timeline">
              {r.deadlines.map((d, i) => (
                <li key={i} className={d.needsReview ? "review" : ""}>
                  <div className="date">
                    {d.date ? formatIsoLong(d.date) : <span className="not-stated">Not stated</span>}
                    {d.original_date && d.original_date !== d.date && (
                      <small className="was">
                        was <s>{formatIsoLong(d.original_date)}</s>
                      </small>
                    )}
                    {d.date && <small><DaysLeft iso={d.date} /></small>}
                  </div>
                  <div>
                    <strong>{d.label}</strong>{" "}
                    {d.mandatory && <span className="chip chip-nobid">mandatory</span>}{" "}
                    {d.revised_by && <span className="chip chip-info">revised · {d.revised_by}</span>}{" "}
                    <StatusChip status={d.status} needsReview={d.needsReview} />
                    {(d.time || d.timezone) && <div className="small muted">{[d.time, d.timezone].filter(Boolean).join(" ")}</div>}
                    <EvidenceList evidence={d.evidence} />
                    {d.note && <div className="note">{d.note}</div>}
                  </div>
                </li>
              ))}
            </ol>
          </section>

          {/* ---------- addenda ---------- */}
          {r.addenda && r.addenda.length > 0 && (
            <section className="card" aria-labelledby="add-h">
              <div className="label"><Icon name="layers" size={13} /> Addenda</div>
              <h2 id="add-h" className="sr-only">Addenda</h2>
              <ul className="req-list">
                {r.addenda.map((a, i) => (
                  <li key={i}>
                    <strong>{a.label}</strong>
                    {a.issued_date && <span className="muted"> · issued {a.issued_date}</span>}{" "}
                    <span className={`chip ${a.confirmed ? "chip-bid" : "chip-warn"}`}>{a.confirmed ? "found in text" : "unconfirmed"}</span>
                    <div>{a.summary}</div>
                    {a.changes.map((c, j) => (
                      <div key={j} className="small">
                        {c.what}: {c.from && <s>{c.from}</s>} {c.to && <>→ <b>{c.to}</b></>}
                      </div>
                    ))}
                    {a.acknowledgement_required && <div className="small"><span className="chip chip-warn">acknowledge in proposal</span></div>}
                    <EvidenceList evidence={a.evidence} />
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* ---------- fit ---------- */}
          {!r.degraded && (
          <section className="card" id="sec-fit" aria-labelledby="fit-h">
            <div className="card-head">
              <div className="label"><span className="num">04</span><Icon name="gauge" size={13} /> Fit score</div>
              <span className="score"><b>{r.fit_score}</b> / 10</span>
            </div>
            <h2 id="fit-h" className="sr-only">Fit score breakdown</h2>
            {r.fit_factors.map((f) => (
              <div className="factor" key={f.id}>
                <strong className="small">{f.label}</strong>
                <div className="bar" aria-hidden="true"><span style={{ width: `${(f.points / f.max) * 100}%` }} /></div>
                <span className="days" style={{ textAlign: "right" }}>{f.points}/{f.max}</span>
                <p>{f.reason}</p>
              </div>
            ))}
            <p className="small muted" style={{ marginBottom: 0 }}>
              BID needs at least 6/10, no blocking deal-breaker, and agreement from the model's judgement.
            </p>
          </section>
          )}

          {/* ---------- evaluation & submission ---------- */}
          {(r.evaluation_criteria || r.submission_items) && (
            <section className="card" id="sec-scoring" aria-labelledby="ev-h">
              <div className="label"><span className="num">05</span><Icon name="scale" size={13} /> How it's scored & what to submit</div>
              <h2 id="ev-h" className="sr-only">Evaluation and submission</h2>
              {r.evaluation_criteria && r.evaluation_criteria.length > 0 ? (
                <table className="desk" style={{ marginTop: 6 }}>
                  <thead>
                    <tr><th scope="col">Criterion</th><th scope="col" style={{ textAlign: "right" }}>Points</th></tr>
                  </thead>
                  <tbody>
                    {r.evaluation_criteria.map((c, i) => (
                      <tr key={i}>
                        <td>
                          {c.name} <EvidenceList evidence={c.evidence} />
                          {c.notes && <div className="note">{c.notes}</div>}
                        </td>
                        <td className="days" style={{ textAlign: "right" }}>{c.points ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="small muted">No weighted criteria stated.</p>
              )}
              {r.award_basis && (
                <p className="small" style={{ marginTop: 8 }}>
                  <strong>Award basis:</strong> {r.award_basis.value} <EvidenceList evidence={r.award_basis.evidence} />
                </p>
              )}
              {r.submission_items && r.submission_items.length > 0 && (
                <>
                  <h3 style={{ marginTop: 12 }}>Submission checklist</h3>
                  <ul className="req-list">
                    {r.submission_items.map((x, i) => (
                      <li key={i}>
                        <span className={`chip ${x.required ? "chip-accent" : "chip-neutral"}`} style={{ marginRight: 6 }}>{x.required ? "required" : "optional"}</span>
                        {x.name}
                        {x.notes && <span className="muted"> · {x.notes}</span>}
                        <EvidenceList evidence={x.evidence} />
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {r.contract_terms && r.contract_terms.length > 0 && (
                <>
                  <h3 style={{ marginTop: 12 }}>Commercial & contract terms</h3>
                  <ul className="req-list">
                    {r.contract_terms.map((x, i) => (
                      <li key={i}>
                        <strong>{x.topic}:</strong> {x.text}
                        <EvidenceList evidence={x.evidence} />
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          )}

          {/* ---------- deal-breakers & questions ---------- */}
          <section className="card" id="sec-risks" aria-labelledby="db-h">
            <div className="label"><span className="num">06</span><Icon name="alert" size={13} /> Deal-breakers</div>
            <h2 id="db-h" className="sr-only">Deal-breakers</h2>
            {r.deal_breakers.length === 0 ? (
              <p className="small muted">{r.degraded ? "Needs the AI assessment. Use Retry." : "None found."}</p>
            ) : (
              <ul className="req-list">
                {r.deal_breakers.map((d, i) => (
                  <li key={i} className={d.needsReview ? "review" : ""}>
                    <span className={`chip ${d.severity === "blocking" ? "chip-nobid" : "chip-warn"}`} style={{ marginRight: 6 }}>
                      {d.severity === "blocking" ? "blocking" : "verify"}
                    </span>
                    {d.text}
                    <EvidenceList evidence={d.evidence} />
                  </li>
                ))}
              </ul>
            )}
            <div className="card-head" style={{ marginTop: 16, marginBottom: 6 }}>
              <h3 style={{ margin: 0 }}>Questions to ask the agency</h3>
              {r.open_questions.length > 0 && (
                <button className="btn btn-sm no-print" onClick={copyQuestions} aria-live="polite">
                  {copied ? "Copied ✓" : "Copy as email"}
                </button>
              )}
            </div>
            {r.open_questions.length === 0 ? (
              <p className="small muted">{r.degraded ? "Needs the AI assessment." : "None."}</p>
            ) : (
              <ol className="reasons small">{r.open_questions.map((q, i) => <li key={i}>{q}</li>)}</ol>
            )}
          </section>
        </div>
      </div>

      <p className="small muted" style={{ marginTop: 14 }}>
        {r.document.fileName} · {r.document.pageCount} pages · analysed by {r.model.provider} ({r.model.name})
        {r.model.latencyMs ? ` in ${(r.model.latencyMs / 1000).toFixed(1)}s` : ""} · {new Date(r.generatedAt).toLocaleString()}
        {r.usage && r.usage.input > 0 && (
          <>
            {" "}· {r.pipeline === "v2" ? "evidence-first pipeline" : "single-call pipeline"}, {r.usage.calls} model call{r.usage.calls > 1 ? "s" : ""}, {r.usage.input.toLocaleString()} input tokens
            {r.usage.cached ? ` (${r.usage.cached.toLocaleString()} cached)` : ""}, {r.usage.output.toLocaleString()} output, {r.usage.thinking.toLocaleString()} thinking
          </>
        )}
      </p>
    </div>
    </CategoryContext.Provider>
  );
}
