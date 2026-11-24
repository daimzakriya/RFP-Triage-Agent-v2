/**
 * OFFLINE TEST FIXTURES. Hand-written model answers for the two challenge
 * sample RFPs, used by unit tests, `npm run eval -- --fixture` and
 * RFP_FIXTURE_MODE=1 for local UI work without an API key.
 * They are never used in normal operation and never reach the deployed app
 * unless RFP_FIXTURE_MODE=1 is set.
 */
import rfp1 from "@/fixtures/sample-rfp-1.model.json";
import rfp2 from "@/fixtures/sample-rfp-2.model.json";
import rfp1Eval from "@/fixtures/sample-rfp-1.evaluation.json";
import rfp2Eval from "@/fixtures/sample-rfp-2.evaluation.json";

const FIXTURES = [
  { marker: "PA-DPI-2026-114", name: "sample-rfp-1.model.json", json: rfp1 as any, evaluation: rfp1Eval as unknown },
  { marker: "LC-FM-2027-03", name: "sample-rfp-2.model.json", json: rfp2 as any, evaluation: rfp2Eval as unknown },
];

export function findFixture(pages: string[]) {
  const head = pages.slice(0, 2).join("\n");
  return FIXTURES.find((f) => head.includes(f.marker)) ?? null;
}

/** v2 pipeline: answer per task, derived from the recorded v1 answers plus the evaluation fixtures. */
export function v2Fixture(task: string, user: string): unknown | null {
  const fx = FIXTURES.find((f) => user.includes(f.marker));
  if (!fx) return null;
  const m = fx.json;

  if (task === "extract.schedule") {
    const deadlines = m.deadlines.map((d: any) =>
      d.kind === "proposal_due" && /extended from/i.test(d.note ?? "")
        ? { ...d, original_date: "2027-01-08", revised_by: "Addendum No. 1" }
        : { ...d, original_date: null, revised_by: null },
    );
    const addenda =
      fx.marker === "PA-DPI-2026-114"
        ? [{
            label: "Addendum No. 1",
            issued_date: "2026-11-24",
            summary: "Extends the proposal due date by one week; all other dates unchanged.",
            changes: [{ what: "Proposal due date", from: "2027-01-08", to: "2027-01-15" }],
            acknowledgement_required: true,
            evidence: [{ page: 5, quote: "Proposers must acknowledge this addendum on Attachment A." }],
          }]
        : [];
    return {
      is_rfp: m.is_rfp,
      title: m.title,
      solicitation_number: m.solicitation_number,
      facts: m.facts,
      deadlines,
      addenda,
      ambiguities: m.ambiguities.filter((a: any) => /date|due/i.test(a.text)),
    };
  }
  if (task === "extract.requirements") {
    return { requirements: m.requirements.map((r: any) => ({ ...r, values: null, basis: "explicit" })), ambiguities: [] };
  }
  if (task === "extract.evaluation") return fx.evaluation;

  if (task === "reason") {
    const dataset = JSON.parse(user.slice(user.indexOf("{"), user.lastIndexOf("}") + 1));
    const software = fx.marker === "PA-DPI-2026-114";
    const compliance = dataset.requirements.map((r: any) => ({
      id: r.id,
      status: software
        ? ["skill", "technical", "accessibility", "security_privacy"].includes(r.category)
          ? "compliant"
          : r.category === "set_aside"
            ? "verify"
            : "unknown"
        : ["past_performance", "staffing", "security_clearance"].includes(r.category)
          ? "non_compliant"
          : "unknown",
      reason: "Fixture assessment.",
    }));
    return {
      summary: m.summary,
      compliance,
      fit_factors: m.fit_factors,
      recommendation: m.recommendation,
      reasons: m.reasons,
      change_mind: m.change_mind,
      deal_breakers: m.deal_breakers.map((d: any) => ({ text: d.text, severity: d.severity, requirement_ids: [] })),
      open_questions: m.open_questions,
    };
  }
  return null;
}
