/**
 * View model for the interface. Turns a stored Bid Desk item (the API report plus where each
 * quote sits in the PDF) into the flat shape the screens render. Pure: no React, no browser APIs.
 */
import type { DeskItem } from "./desk";
import { collectFindings, evidenceKey, type Box, type HighlightCategory } from "./evidence-map";
import type { ComplianceStatus, EvidenceCheck, Requirement, TriageReport, VerifiedEvidence } from "./schema";

export interface ViewEv {
  page: number;
  quote: string;
  boxes: Box[];
  /** How precisely the quote was found in the PDF layout. */
  conf: "exact" | "fuzzy" | "none";
  /** Result of the server-side text check. */
  check: EvidenceCheck;
  /** Position in the report's evidence index (set by `findings`). */
  _i?: number;
}

export type ReqStatus = "meets" | "verify" | "fails";

export interface ReportView {
  id: string;
  docId?: string;
  pages?: string[];
  fileName: string;
  pageCount: number;
  generatedAt: string;
  title: string;
  solicitation: string;
  agency: string;
  decision: "BID" | "NO_BID" | "UNDETERMINED";
  degraded: boolean;
  degradedReason: string | null;
  fastNoBid: boolean;
  decisionNote: string | null;
  fit: number;
  summary: string;
  facts: { key: string; label: string; value: string; notStated: boolean; review: boolean; note?: string | null; cat: HighlightCategory; ev: ViewEv[] }[];
  dates: { label: string; kind: string; date: string | null; time: string | null; mandatory: boolean; note?: string | null; was?: string | null; revisedBy?: string | null; ambiguous: boolean; ev: ViewEv[] }[];
  requirements: { id: string; group: string; cat: HighlightCategory; must: boolean; status: ReqStatus; compliance?: ComplianceStatus; text: string; values?: string | null; reason: string; ev: ViewEv[] }[];
  fitFactors: { label: string; points: number; max: number; reason: string }[];
  reasons: string[];
  changeMind: string[];
  dealBreakers: { severity: "blocking" | "verify"; text: string; ev: ViewEv[] }[];
  questions: string[];
  ambiguities: { text: string; ev: ViewEv[] }[];
  flags: { level: "warning" | "info"; text: string }[];
  evidenceStats: TriageReport["evidence_stats"];
  quality: { status: "verified" | "needs_review" | "incomplete"; checks: { label: string; status: "pass" | "warn" | "fail"; detail: string }[] } | null;
  addenda: { label: string; issued: string | null; summary: string; changes: { what: string; from: string | null; to: string | null }[]; ack: boolean; confirmed: boolean; ev: ViewEv[] }[];
  criteria: { name: string; points: number | null; note: string | null; ev: ViewEv[] }[];
  award: { text: string; ev: ViewEv[] } | null;
  submission: { name: string; required: boolean; note: string | null; limit: number | null; ev: ViewEv[] }[];
  terms: { topic: string; text: string; ev: ViewEv[] }[];
}

export const FACT_LABELS: Record<keyof TriageReport["facts"], string> = {
  agency: "Agency",
  scope: "Scope of work",
  contract_type: "Contract type",
  contract_value: "Contract value",
  work_location: "Work location",
  period_of_performance: "Contract term",
  submission_method: "How to submit",
};

export const REQ_LABELS: Record<Requirement["category"], string> = {
  set_aside: "Set-asides",
  past_performance: "Experience",
  certification: "Certifications",
  security_clearance: "Background checks",
  registration: "Registrations",
  staffing: "Staffing",
  skill: "Skills",
  technical: "Technical",
  security_privacy: "Security and data",
  accessibility: "Accessibility",
  insurance_bonding: "Insurance and bonding",
  contract_terms: "Contract obligations",
  other: "Other",
};
const REQ_ORDER = Object.keys(REQ_LABELS) as Requirement["category"][];
const ELIGIBILITY = new Set(["set_aside", "past_performance", "registration", "certification", "insurance_bonding", "security_clearance"]);

export function reqStatus(c: ComplianceStatus | undefined): ReqStatus {
  if (c === "compliant") return "meets";
  if (c === "non_compliant") return "fails";
  return "verify"; // partial, unknown, verify or not assessed: a person should confirm it
}

/** Page limit stated for a submission item, e.g. "no more than 12 pages" or "2-page cover letter". */
export function pageLimit(text: string): number | null {
  const m =
    /(?:no more than|not (?:to )?exceed|maximum(?: of)?|max\.?|up to|limit(?:ed)? to)\s*(\d{1,3})\s*(?:pages?|pp\b)/i.exec(text) ??
    /\b(\d{1,3})[- ]page\b/i.exec(text) ??
    /\b(\d{1,3})\s*pages?\s*(?:max(?:imum)?|limit)\b/i.exec(text);
  return m ? Number(m[1]) : null;
}

/** First dollar amount in a contract value, e.g. "$420,000" or "$1.2 million". */
export function moneyIn(text: string): string | null {
  return /\$\s?[\d,.]+(?:\s?(?:million|billion|[MK]\b))?/i.exec(text)?.[0] ?? null;
}

/** An array, or empty when the saved value is missing or malformed. */
const arr = <T,>(x: T[] | null | undefined): T[] => (Array.isArray(x) ? x : []);

const NOT_STATED = { value: "Not stated", status: "not_stated" as const, note: null, evidence: [], needsReview: false };

/** A saved report with every list and fact present. Reports saved by older versions may lack newer fields. */
export function normalizeReport(raw: TriageReport): TriageReport {
  return {
    ...raw,
    document: raw.document ?? { fileName: "Untitled.pdf", pageCount: 0, characters: 0, truncated: false },
    facts: (Object.fromEntries((Object.keys(FACT_LABELS) as (keyof typeof FACT_LABELS)[]).map((k) => [k, (raw.facts && typeof raw.facts === "object" ? raw.facts[k] : null) ?? NOT_STATED])) as TriageReport["facts"]),
    deadlines: arr(raw.deadlines),
    requirements: arr(raw.requirements),
    fit_factors: arr(raw.fit_factors),
    reasons: arr(raw.reasons),
    change_mind: arr(raw.change_mind),
    deal_breakers: arr(raw.deal_breakers),
    open_questions: arr(raw.open_questions),
    ambiguities: arr(raw.ambiguities),
    review_flags: arr(raw.review_flags),
    evidence_stats: raw.evidence_stats ?? { total: 0, verified: 0, approximate: 0, unverified: 0 },
  } as TriageReport;
}

export function toView(item: DeskItem): ReportView {
  const r = normalizeReport(item.report);
  let cats = new Map<string, HighlightCategory>();
  try { cats = new Map(collectFindings(r).map((f) => [f.key, f.category])); } catch { /* colours fall back to defaults */ }
  const ev = (list: VerifiedEvidence[] | undefined): ViewEv[] =>
    arr(list).filter((e) => e && typeof e.quote === "string" && e.page > 0).map((e) => {
      const loc = item.locations?.[evidenceKey(e)];
      return {
        page: loc?.page ?? e.page,
        quote: e.quote,
        boxes: loc?.boxes ?? [],
        conf: loc ? loc.confidence : e.check === "unverified" ? "none" : e.check === "approximate" ? "fuzzy" : "exact",
        check: e.check,
      };
    });
  const catOf = (list: VerifiedEvidence[] | undefined, fallback: HighlightCategory) => (list?.[0] && cats.get(evidenceKey(list[0]))) || fallback;

  const reqs = REQ_ORDER.flatMap((c) => r.requirements.filter((q) => q.category === c)).map((q, i) => ({
    id: q.id || `R${i + 1}`,
    group: REQ_LABELS[q.category] ?? "Other",
    cat: catOf(q.evidence, ELIGIBILITY.has(q.category) ? "eligibility" : q.category === "contract_terms" ? "contract" : q.mandatory ? "mandatory" : "evaluation"),
    must: q.mandatory,
    status: reqStatus(q.compliance),
    compliance: q.compliance,
    text: q.text ?? "",
    values: q.values && !(q.text ?? "").includes(q.values) ? q.values : null,
    reason: q.compliance_reason ?? "",
    ev: ev(q.evidence),
  }));

  return {
    id: item.id,
    docId: item.docId,
    pages: item.pages,
    fileName: r.document.fileName,
    pageCount: r.document.pageCount,
    generatedAt: r.generatedAt || item.addedAt || new Date().toISOString(),
    title: r.title || r.document.fileName,
    solicitation: r.solicitation_number && !/^not stated$/i.test(r.solicitation_number) ? r.solicitation_number : "",
    agency: r.facts.agency.status === "not_stated" ? "" : r.facts.agency.value,
    decision: r.decision ?? "UNDETERMINED",
    degraded: !!r.degraded || r.decision === "UNDETERMINED" || !r.decision,
    degradedReason: typeof r.degradedReason === "string" && r.degradedReason ? r.degradedReason : null,
    fastNoBid: !!r.fastNoBid,
    decisionNote: r.decisionNote ?? null,
    fit: typeof r.fit_score === "number" ? r.fit_score : 0,
    summary: r.summary ?? "",
    facts: (Object.keys(FACT_LABELS) as (keyof typeof FACT_LABELS)[]).map((k) => {
      const f = r.facts[k];
      return {
        key: k,
        label: FACT_LABELS[k],
        value: f.status === "not_stated" ? "Not stated" : f.value,
        notStated: f.status === "not_stated",
        review: f.needsReview || f.status === "ambiguous",
        note: f.note,
        cat: catOf(f.evidence, ["contract_value", "contract_type", "period_of_performance"].includes(k) ? "contract" : "other"),
        ev: ev(f.evidence),
      };
    }),
    dates: r.deadlines.map((d) => ({
      label: d.label,
      kind: d.kind === "proposal_due" ? "proposal" : d.kind,
      date: d.date ?? null,
      time: [d.time, d.timezone].filter(Boolean).join(" ") || null,
      mandatory: d.mandatory,
      note: d.note,
      was: d.original_date && d.original_date !== d.date ? d.original_date : null,
      revisedBy: d.revised_by,
      ambiguous: d.status === "ambiguous" || d.needsReview,
      ev: ev(d.evidence),
    })),
    requirements: reqs,
    fitFactors: r.fit_factors.map((f) => ({ label: f.label, points: f.points, max: f.max, reason: f.reason })),
    reasons: r.reasons,
    changeMind: r.change_mind,
    dealBreakers: r.deal_breakers.map((d) => ({ severity: d.severity, text: d.text, ev: ev(d.evidence) })),
    questions: r.open_questions,
    ambiguities: r.ambiguities.map((a) => ({ text: a.text, ev: ev(a.evidence) })),
    flags: [...r.review_flags].sort((a, b) => (a.level === b.level ? 0 : a.level === "warning" ? -1 : 1)).map((f) => ({ level: f.level, text: f.message })),
    evidenceStats: r.evidence_stats,
    quality: r.quality ? { status: r.quality.status, checks: arr(r.quality.checks).map((c) => ({ label: c.label, status: c.status, detail: c.detail })) } : null,
    addenda: arr(r.addenda).map((a) => ({ label: a.label, issued: a.issued_date, summary: a.summary, changes: arr(a.changes), ack: a.acknowledgement_required, confirmed: a.confirmed, ev: ev(a.evidence) })),
    criteria: arr(r.evaluation_criteria).map((c) => ({ name: c.name, points: c.points, note: c.notes, ev: ev(c.evidence) })),
    award: r.award_basis && r.award_basis.status !== "not_stated" ? { text: r.award_basis.value, ev: ev(r.award_basis.evidence) } : null,
    submission: arr(r.submission_items).map((s) => ({ name: s.name, required: s.required, note: s.notes, limit: pageLimit(`${s.name} ${s.notes ?? ""}`), ev: ev(s.evidence) })),
    terms: arr(r.contract_terms).map((t) => ({ topic: t.topic, text: t.text, ev: ev(t.evidence) })),
  };
}

/* One view per stored item, rebuilt only when the item changes. */
const views = new WeakMap<DeskItem, ReportView>();
export function viewOf(item: DeskItem): ReportView {
  let v = views.get(item);
  if (!v) views.set(item, (v = toView(item)));
  return v;
}
