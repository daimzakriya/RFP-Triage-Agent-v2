/**
 * Stage 3: reasoning over the consolidated, evidence-checked dataset (not the PDF).
 * The model assesses compliance per requirement ID and scores fit; code then
 * applies deterministic caps and the decision rule (see consolidate.ts / score.ts).
 */
import { z } from "zod";
import { profileAsPromptText } from "../profile";
import { BID_THRESHOLD, RUBRIC } from "../score";
import { FactorId } from "../schema";

export function reasonSystem(): string {
  const rubric = Object.entries(RUBRIC)
    .map(([id, r]) => `- ${id} (0-${r.max}): ${r.guide}`)
    .join("\n");
  return `You are the bid/no-bid analyst for idiaz.io. You receive a structured compliance dataset extracted from one RFP (every item already has a verified page reference). You do NOT see the PDF; reason only from the dataset and the company profile.

COMPANY PROFILE
${profileAsPromptText()}

COMPLIANCE (one entry per requirement id, every id must appear)
- compliant: the profile clearly satisfies it (e.g. "US-registered" for a US-registration rule, software work we build).
- non_compliant: the profile clearly cannot satisfy it (e.g. non-software labour, a mandatory local crew).
- partial: part is satisfied, part is not or unknown.
- unknown: the profile says nothing that bears on it (most insurance limits, certifications, years in business, references).
- verify: plausible but needs a fact the team must confirm before bidding.
Never assume idiaz.io holds a certification, insurance limit, registration, clearance, reference or years of experience that the profile does not state. Those are "unknown" or "verify", never "compliant".

FIT RUBRIC (points per factor, one-line reason citing requirement ids like [R4] or dataset facts)
${rubric}

DECISION
recommendation BID only if the total is ${BID_THRESHOLD}+ and nothing mandatory is non_compliant. deal_breakers: "blocking" only for mandatory items idiaz.io clearly cannot meet; "verify" for mandatory items that need confirmation. Cite requirement_ids.
reasons: exactly 3, strongest first, each citing ids or facts. change_mind: 2-4 concrete facts that would flip the decision. open_questions: 2-6 questions for the agency, grounded in gaps or ambiguities in the dataset. summary: 3-5 plain-English sentences on what the buyer wants. In your own wording (everything except quotes), write plain sentences and do not use em dashes or en dashes; use a comma, colon or full stop instead.`;
}

const S = "STRING", N = "NUMBER", O = "OBJECT", A = "ARRAY";
const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: O, properties, required, propertyOrdering: Object.keys(properties) });

export const REASON_SCHEMA = obj(
  {
    summary: { type: S },
    compliance: {
      type: A,
      items: obj({ id: { type: S }, status: { type: S, enum: ["compliant", "non_compliant", "partial", "unknown", "verify"] }, reason: { type: S } }, ["id", "status", "reason"]),
    },
    fit_factors: {
      type: A,
      items: obj({ id: { type: S, enum: FactorId.options }, points: { type: N }, reason: { type: S } }, ["id", "points", "reason"]),
    },
    recommendation: { type: S, enum: ["BID", "NO_BID"] },
    reasons: { type: A, items: { type: S } },
    change_mind: { type: A, items: { type: S } },
    deal_breakers: {
      type: A,
      items: obj({ text: { type: S }, severity: { type: S, enum: ["blocking", "verify"] }, requirement_ids: { type: A, items: { type: S } } }, ["text", "severity", "requirement_ids"]),
    },
    open_questions: { type: A, items: { type: S } },
  },
  ["summary", "compliance", "fit_factors", "recommendation", "reasons", "change_mind", "deal_breakers", "open_questions"],
);

export const ReasonOut = z.object({
  summary: z.string(),
  compliance: z.array(z.object({ id: z.string(), status: z.enum(["compliant", "non_compliant", "partial", "unknown", "verify"]), reason: z.string() })),
  fit_factors: z.array(z.object({ id: FactorId, points: z.number(), reason: z.string() })),
  recommendation: z.enum(["BID", "NO_BID"]),
  reasons: z.array(z.string()).min(1),
  change_mind: z.array(z.string()).default([]),
  deal_breakers: z.array(z.object({ text: z.string(), severity: z.enum(["blocking", "verify"]), requirement_ids: z.array(z.string()).default([]) })).default([]),
  open_questions: z.array(z.string()).default([]),
});
export type ReasonOutT = z.infer<typeof ReasonOut>;

/** Compact, complete dataset for the reasoning call: every requirement, no PDF text. */
export function reasonUser(dataset: unknown): string {
  return `COMPLIANCE DATASET (JSON):\n${JSON.stringify(dataset)}\n\nAssess every requirement id, score the rubric and decide.`;
}
