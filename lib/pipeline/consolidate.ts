/**
 * Stage 2 (deterministic): merge worker outputs into one compliance dataset.
 * No model calls. Every item keeps its evidence trail.
 */
import { formatIsoLong, normalize } from "../dates";
import type { ComplianceStatus, Evidence, Requirement, ReviewFlag, ScoredFactor } from "../schema";
import type { ChangeStatement } from "./preprocess";
import type { RequirementsOutT, ScheduleOutT } from "./workers";

/* ------------------------------ requirements ------------------------------ */

type RawReq = RequirementsOutT["requirements"][number];
export type MergedReq = RawReq & { id: string };

const CATEGORY_ORDER: Requirement["category"][] = [
  "set_aside", "past_performance", "registration", "certification", "security_clearance", "staffing",
  "insurance_bonding", "security_privacy", "accessibility", "technical", "skill", "contract_terms", "other",
];

function words(s: string): Set<string> {
  return new Set(normalize(s).split(/[^a-z0-9$%.]+/).filter((w) => w.length > 2));
}
function overlap(a: Set<string>, b: Set<string>) {
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return { jaccard: inter / (a.size + b.size - inter || 1), containment: inter / (Math.min(a.size, b.size) || 1) };
}
/** Same requirement worded twice: high overall overlap, or one wording almost fully contained in the other. */
function sameRequirement(a: Set<string>, b: Set<string>) {
  const o = overlap(a, b);
  return o.jaccard >= 0.7 || (o.containment >= 0.85 && o.jaccard >= 0.5);
}
function mergeEvidence(a: Evidence[], b: Evidence[]): Evidence[] {
  const seen = new Set(a.map((e) => `${e.page}|${normalize(e.quote)}`));
  return [...a, ...b.filter((e) => !seen.has(`${e.page}|${normalize(e.quote)}`))];
}

/**
 * Duplicate detection: same category and near-identical wording (see sameRequirement),
 * or the same verbatim quote cited for the same category. Merged items keep
 * the longer wording, all evidence, and mandatory if either copy was mandatory.
 */
export function mergeRequirements(reqs: RawReq[]): { merged: MergedReq[]; duplicatesRemoved: number } {
  const out: RawReq[] = [];
  let dups = 0;
  for (const r of reqs) {
    const rw = words(`${r.text} ${r.values ?? ""}`);
    const rq = new Set(r.evidence.map((e) => normalize(e.quote)));
    const twin = out.find(
      (o) =>
        o.category === r.category &&
        (sameRequirement(words(`${o.text} ${o.values ?? ""}`), rw) || o.evidence.some((e) => rq.has(normalize(e.quote)))),
    );
    if (twin) {
      dups++;
      if (r.text.length > twin.text.length) twin.text = r.text;
      twin.values = twin.values ?? r.values;
      twin.mandatory = twin.mandatory || r.mandatory;
      twin.basis = twin.basis === "explicit" || r.basis === "explicit" ? "explicit" : "interpreted";
      twin.evidence = mergeEvidence(twin.evidence, r.evidence);
    } else {
      out.push({ ...r, evidence: [...r.evidence] });
    }
  }
  const firstPage = (r: RawReq) => Math.min(...r.evidence.map((e) => e.page), 9999);
  out.sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || firstPage(a) - firstPage(b));
  return { merged: out.map((r, i) => ({ ...r, id: `R${i + 1}` })), duplicatesRemoved: dups };
}

/* -------------------------------- addenda -------------------------------- */

type RawDeadline = ScheduleOutT["deadlines"][number];

/**
 * Reconcile the schedule worker's dates with the change statements found by text search.
 * - A revision is accepted only if a change statement (from -> to) supports it.
 * - If the text shows a date was changed but the model kept the superseded date,
 *   the revised date is used and the correction is flagged.
 * - A revision the model claims without a supporting statement is flagged for human verification.
 */
export function reconcileDeadlines(deadlines: RawDeadline[], changes: ChangeStatement[], flags: ReviewFlag[]): RawDeadline[] {
  return deadlines.map((d) => {
    const field = `deadlines.${d.kind}`;
    if (!d.date) return d;
    const supersededBy = changes.find((c) => c.from === d.date);
    if (supersededBy) {
      flags.push({
        level: "warning",
        field,
        message: `The text on p.${supersededBy.page} says this date changed from ${formatIsoLong(supersededBy.from)} to ${formatIsoLong(supersededBy.to)}${supersededBy.addendum ? ` (${supersededBy.addendum})` : ""}, but the model reported the old date. Using the revised date. Confirm.`,
      });
      return {
        ...d,
        original_date: d.date,
        date: supersededBy.to,
        revised_by: supersededBy.addendum ?? d.revised_by ?? "revision statement",
        evidence: [...d.evidence, { page: supersededBy.page, quote: supersededBy.quote.slice(0, 200) }],
        note: [d.note, `Corrected to the revised date stated on p.${supersededBy.page}.`].filter(Boolean).join(" "),
      };
    }
    if (d.original_date && d.original_date !== d.date) {
      const support = changes.find((c) => c.from === d.original_date && c.to === d.date);
      if (support) {
        flags.push({
          level: "info",
          field,
          message: `Revised date confirmed: ${formatIsoLong(d.original_date)} → ${formatIsoLong(d.date)}${support.addendum ? ` by ${support.addendum}` : ""} (p.${support.page}).`,
        });
        return { ...d, revised_by: d.revised_by ?? support.addendum };
      }
      flags.push({
        level: "warning",
        field,
        message: `The model says this date was revised from ${formatIsoLong(d.original_date)}, but no explicit change statement was found in the text. Human verification needed.`,
      });
    }
    return d;
  });
}

/* ------------------------------ compliance ------------------------------ */

const ELIGIBILITY: Requirement["category"][] = [
  "set_aside", "past_performance", "registration", "certification", "security_clearance", "insurance_bonding", "staffing",
];

/**
 * Deterministic caps so the score can't contradict the compliance findings:
 * - a mandatory requirement judged non_compliant zeroes eligibility (and is a blocking deal-breaker);
 * - mandatory eligibility items that are unknown/verify cap eligibility (1.5 for 1-2 items, 1 for 3+).
 */
export function applyComplianceCaps(
  factors: ScoredFactor[],
  reqs: (MergedReq & { compliance: ComplianceStatus })[],
): { factors: ScoredFactor[]; notes: string[] } {
  const notes: string[] = [];
  const mandatoryElig = reqs.filter((r) => r.mandatory && ELIGIBILITY.includes(r.category));
  const failing = reqs.filter((r) => r.mandatory && r.compliance === "non_compliant");
  const open = mandatoryElig.filter((r) => r.compliance === "unknown" || r.compliance === "verify" || r.compliance === "partial");
  const cap = failing.length ? 0 : open.length >= 3 ? 1 : open.length >= 1 ? 1.5 : 2;
  const out = factors.map((f) => {
    if (f.id !== "eligibility" || f.points <= cap) return f;
    const why = failing.length
      ? `capped at 0: mandatory ${failing.map((r) => r.id).join(", ")} not met`
      : `capped at ${cap}: ${open.length} mandatory eligibility item(s) unconfirmed (${open.slice(0, 6).map((r) => r.id).join(", ")}${open.length > 6 ? "…" : ""})`;
    notes.push(`Eligibility ${why}.`);
    return { ...f, points: cap, reason: `${f.reason} (${why})` };
  });
  return { factors: out, notes };
}
