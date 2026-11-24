import { z } from "zod";

/* ------------------------------------------------------------------ */
/* 1. What the model must return (validated with zod after the call)   */
/* ------------------------------------------------------------------ */

export const EvidenceSchema = z.object({
  page: z.number().int().min(1),
  quote: z.string().min(1).max(400),
});

export const FieldStatus = z.enum(["stated", "not_stated", "ambiguous"]);

export const FactSchema = z.object({
  value: z.string(), // "Not stated" when missing
  status: FieldStatus,
  note: z.string().nullish(),
  evidence: z.array(EvidenceSchema).default([]),
});

export const DeadlineKind = z.enum([
  "questions_due",
  "proposal_due",
  "site_visit",
  "pre_proposal_conference",
  "work_start",
  "award",
  "other",
]);

export const DeadlineSchema = z.object({
  kind: DeadlineKind,
  label: z.string(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish(), // ISO date, null when not stated / not a single day
  time: z.string().nullish(),
  timezone: z.string().nullish(),
  mandatory: z.boolean().default(false),
  status: FieldStatus,
  note: z.string().nullish(),
  evidence: z.array(EvidenceSchema).default([]),
});

export const RequirementCategory = z.enum([
  "skill",
  "certification",
  "set_aside",
  "security_clearance",
  "past_performance",
  "staffing",
  "registration",
  "insurance_bonding",
  "technical",
  "security_privacy",
  "accessibility",
  "contract_terms",
  "other",
]);

export const RequirementSchema = z.object({
  category: RequirementCategory,
  text: z.string(),
  mandatory: z.boolean(),
  evidence: z.array(EvidenceSchema).default([]),
});

export const FactorId = z.enum([
  "service_match",
  "team_fit",
  "eligibility",
  "commercial",
  "timeline",
]);

export const FitFactorSchema = z.object({
  id: FactorId,
  points: z.number(),
  reason: z.string(),
});

export const DealBreakerSchema = z.object({
  text: z.string(),
  severity: z.enum(["blocking", "verify"]),
  evidence: z.array(EvidenceSchema).default([]),
});

export const AmbiguitySchema = z.object({
  text: z.string(),
  evidence: z.array(EvidenceSchema).default([]),
});

export const ModelOutputSchema = z.object({
  is_rfp: z.boolean(),
  title: z.string(),
  solicitation_number: z.string(),
  summary: z.string(),
  facts: z.object({
    agency: FactSchema,
    scope: FactSchema,
    contract_type: FactSchema,
    contract_value: FactSchema,
    work_location: FactSchema,
    period_of_performance: FactSchema,
    submission_method: FactSchema,
  }),
  deadlines: z.array(DeadlineSchema),
  requirements: z.array(RequirementSchema),
  fit_factors: z.array(FitFactorSchema),
  recommendation: z.enum(["BID", "NO_BID"]),
  reasons: z.array(z.string()).min(1),
  change_mind: z.array(z.string()).default([]),
  deal_breakers: z.array(DealBreakerSchema).default([]),
  open_questions: z.array(z.string()).default([]),
  ambiguities: z.array(AmbiguitySchema).default([]),
});

export type Evidence = z.infer<typeof EvidenceSchema>;
export type Fact = z.infer<typeof FactSchema>;
export type Deadline = z.infer<typeof DeadlineSchema>;
export type Requirement = z.infer<typeof RequirementSchema>;
export type FitFactor = z.infer<typeof FitFactorSchema>;
export type ModelOutput = z.infer<typeof ModelOutputSchema>;
export type FactKey = keyof ModelOutput["facts"];

/* ------------------------------------------------------------------ */
/* 2. What the API returns to the UI (after verification + scoring)    */
/* ------------------------------------------------------------------ */

export type EvidenceCheck =
  | "verified" // quote found on the cited page
  | "relocated" // quote found, but on a different page (page corrected)
  | "approximate" // close match (>= 80% of words) on the cited page
  | "unverified"; // could not be found in the document text

export interface VerifiedEvidence extends Evidence {
  check: EvidenceCheck;
  citedPage?: number; // original page when relocated
}

export interface ReviewFlag {
  level: "warning" | "info";
  field: string; // e.g. "deadlines.proposal_due"
  message: string;
}

export interface ScoredFactor {
  id: z.infer<typeof FactorId>;
  label: string;
  points: number;
  max: number;
  reason: string;
}

export type ComplianceStatus = "compliant" | "non_compliant" | "partial" | "unknown" | "verify";

export interface Addendum {
  label: string; // "Addendum No. 1"
  issued_date: string | null;
  summary: string;
  changes: { what: string; from: string | null; to: string | null }[];
  acknowledgement_required: boolean;
  evidence: VerifiedEvidence[];
  confirmed: boolean; // a change statement for it was found in the document text
}

export interface QualityCheck {
  id: string;
  label: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

export type Verified<T extends { evidence: Evidence[] }> = Omit<T, "evidence"> & {
  evidence: VerifiedEvidence[];
  needsReview: boolean;
};

export interface TriageReport {
  schemaVersion: "1.0";
  generatedAt: string;
  document: {
    fileName: string;
    pageCount: number;
    characters: number;
    truncated: boolean;
  };
  model: { provider: string; name: string; latencyMs: number };

  decision: "BID" | "NO_BID" | "UNDETERMINED"; // UNDETERMINED only in degraded (no-AI) reports
  fastNoBid: boolean;
  modelRecommendation: "BID" | "NO_BID" | "UNDETERMINED";
  degraded?: boolean; // true when every AI provider was unavailable and the report is text-search only
  degradedReason?: string;
  decisionNote: string | null;

  fit_score: number; // 0-10
  fit_factors: ScoredFactor[];

  title: string;
  solicitation_number: string;
  summary: string;
  facts: Record<FactKey, Verified<Fact>>;
  deadlines: (Verified<Deadline> & { what: string; original_date?: string | null; revised_by?: string | null })[]; // `what` mirrors the brief's example shape
  requirements: (Verified<Requirement> & {
    id?: string;
    values?: string | null;
    basis?: "explicit" | "interpreted";
    compliance?: ComplianceStatus;
    compliance_reason?: string;
  })[];
  reasons: string[];
  change_mind: string[];
  deal_breakers: Verified<z.infer<typeof DealBreakerSchema>>[];
  open_questions: string[];
  ambiguities: Verified<z.infer<typeof AmbiguitySchema>>[];

  review_flags: ReviewFlag[];
  evidence_stats: { total: number; verified: number; approximate: number; unverified: number };

  /* v2 pipeline additions (absent in v1 reports) */
  pipeline?: "v1" | "v2";
  addenda?: Addendum[];
  evaluation_criteria?: Verified<{ name: string; points: number | null; notes: string | null; evidence: Evidence[] }>[];
  award_basis?: Verified<Fact>;
  submission_items?: Verified<{ name: string; required: boolean; notes: string | null; evidence: Evidence[] }>[];
  contract_terms?: Verified<{ topic: string; text: string; evidence: Evidence[] }>[];
  quality?: { status: "verified" | "needs_review" | "incomplete"; checks: QualityCheck[] };
  usage?: { calls: number; input: number; output: number; thinking: number; cached: number; ms: number; byTask: { task: string; model: string; provider: string; ms: number; input: number; output: number; thinking: number; cached: number }[] };
}
