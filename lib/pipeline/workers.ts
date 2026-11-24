/**
 * Stage 1: three narrow extraction workers. Each has ONE responsibility and its
 * own response schema. All share the same system prompt and the same document
 * prefix, so Gemini's implicit cache can serve the document tokens after the first call.
 */
import { z } from "zod";
import {
  AmbiguitySchema,
  DeadlineKind,
  EvidenceSchema,
  FactSchema,
  FieldStatus,
  RequirementCategory,
} from "../schema";
import type { ChangeStatement, WorkerId } from "./preprocess";

/* ----------------------------- shared prompt ----------------------------- */

/** Identical for every extraction call (keeps the cacheable prefix stable). */
export const EXTRACTION_SYSTEM = `You extract facts from one government RFP for a bid team. You are precise, literal and complete.

RULES (apply to every task)
- Use ONLY the RFP text supplied between the DOCUMENT markers. No outside knowledge, no assumptions about the bidder.
- Evidence: every extracted item carries evidence = [{page, quote}]. "page" is the number from the [[PAGE n]] marker. "quote" is copied VERBATIM from that page (5–30 words). Never paraphrase inside a quote. Use "..." only to join two parts of the same sentence.
- Missing information: use null (or status "not_stated"). Never invent a value to fill a field.
- Copy numbers, money, percentages, durations, distances and dates exactly as written.
- Ambiguity or conflict in the RFP text: do not silently pick one reading. Report it in "ambiguities" with evidence for each side.
- Explicit vs interpreted: if the RFP states something directly, it is explicit. If you are inferring it, say so in the "basis" or "note" field.
- Do only the task you are given. Do not summarise the whole document.`;

export function extractionUser(documentText: string, pageCount: number, task: string): string {
  // Document first, task last: the long shared prefix is identical across workers.
  return `=== DOCUMENT START (${pageCount} pages) ===\n${documentText}\n=== DOCUMENT END ===\n\n=== TASK ===\n${task}`;
}

/* ------------------------------ task texts ------------------------------- */

export function scheduleTask(changes: ChangeStatement[]): string {
  const hints = changes.length
    ? `\nThe following explicit change statements were found by text search. Check each against the document and use them:\n${changes
        .map((c) => `- p.${c.page}: "${c.quote}" (from ${c.from} to ${c.to}${c.addendum ? `, ${c.addendum}` : ""})`)
        .join("\n")}\n`
    : "";
  return `TASK: SCHEDULE, KEY FACTS AND ADDENDA.
1. title and solicitation_number exactly as printed; is_rfp=false if this is not a solicitation.
2. facts: agency, scope (one or two sentences, what the buyer wants delivered), contract_type, contract_value (exact figures and what they cover), work_location, period_of_performance, submission_method (how, where, format, page limits, copies). value "Not stated" + status "not_stated" when absent.
3. deadlines: every dated event. ALWAYS include kinds questions_due, proposal_due, site_visit, work_start (status "not_stated", date null if absent). Also pre_proposal_conference, award and other dated events. date = ISO YYYY-MM-DD; time and timezone as written; mandatory=true only for events the RFP calls mandatory or where non-attendance disqualifies.
4. ADDENDA (critical): list every addendum or amendment that the document contains or refers to, with what it changes. A date counts as revised ONLY when the text explicitly says it was changed (e.g. "extended from X to Y", a struck/replaced date labelled as revised by an addendum). A later date appearing elsewhere is NOT evidence of a change. For a revised deadline set date = the revised date, original_date = the earlier date, revised_by = the addendum label, and cite the change statement as evidence. If you cannot find the modifying text, keep the date as printed, set original_date null and add an ambiguity asking for human verification. Note any addendum obligations (e.g. acknowledgement required on a form).${hints}
5. ambiguities: conflicting or unclear dates/facts only.`;
}

export const REQUIREMENTS_TASK = `TASK: REQUIREMENTS A BIDDER MUST MEET OR PROVE.
Sweep EVERY page, including scope sections, minimum qualifications, technical/functional tables, security and data sections, contract terms, attachments, forms and questionnaires. Extract each distinct requirement once:
- category: one of set_aside, past_performance, registration, certification, security_clearance, staffing, insurance_bonding, security_privacy, accessibility, technical, skill, contract_terms, other.
  - past_performance: years in business, prior projects, references.
  - staffing: key personnel, on-site/in-person, local presence, wage rules, staffing levels.
  - insurance_bonding: each insurance type with its limit; bid/performance/fidelity bonds.
  - security_privacy: hosting location, certifications like SOC 2/FedRAMP, encryption, SSO/MFA, data use, retention, breach notice.
  - accessibility: WCAG/ADA/language access.
  - technical / skill: functional and integration mandates, performance/SLA targets, AI-specific rules.
  - contract_terms: obligations that bind the contractor (acceptance testing, liquidated damages, termination triggers, payment conditions).
- text: the requirement in plain words, keeping every number and condition.
- values: the exact figures/limits as written (e.g. "$2,000,000 per claim"), else null.
- mandatory: true for must/shall/required/[M]/pass-fail/minimum qualification; false for desired/[D]/preferred/scored-only.
- basis: "explicit" if stated outright, "interpreted" if you inferred it.
- evidence: page + verbatim quote. A requirement without evidence must not be listed.
Do not merge unrelated items; do not repeat the same requirement twice. Report unclear or conflicting requirements in ambiguities.`;

export const EVALUATION_TASK = `TASK: EVALUATION, SUBMISSION AND COMMERCIAL TERMS.
1. evaluation_criteria: each scored criterion exactly as listed, with points (number) or null if unweighted; notes for formulas, separate stages (e.g. demonstrations) or pass/fail screens. Empty list if the RFP gives none.
2. award_basis: how the winner is chosen (best value, lowest responsive bidder, preferences applied). "Not stated" if absent.
3. submission_items: every document, form, attachment or appendix the bidder must submit or complete (name as written; required true/false; notes for limits like page counts or separate files).
4. contract_terms: commercial and contractual terms that matter for a bid decision: budget/not-to-exceed, pricing structure, payment terms, retainage/holdbacks, liquidated damages or credits, termination, acceptance, warranty, IP/data ownership, insurance/bonding timing. topic + exact text.
Use evidence for every item.`;

/* ------------------------- response schemas (Gemini) ------------------------- */

const S = "STRING", N = "NUMBER", I = "INTEGER", B = "BOOLEAN", O = "OBJECT", A = "ARRAY";
const evidence = {
  type: A,
  items: { type: O, properties: { page: { type: I }, quote: { type: S } }, required: ["page", "quote"], propertyOrdering: ["page", "quote"] },
};
const status = { type: S, enum: ["stated", "not_stated", "ambiguous"] };
const fact = {
  type: O,
  properties: { value: { type: S }, status, note: { type: S, nullable: true }, evidence },
  required: ["value", "status", "evidence"],
  propertyOrdering: ["value", "status", "note", "evidence"],
};
const ambiguities = {
  type: A,
  items: { type: O, properties: { text: { type: S }, evidence }, required: ["text", "evidence"], propertyOrdering: ["text", "evidence"] },
};
const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: O, properties, required, propertyOrdering: Object.keys(properties) });

export const SCHEDULE_SCHEMA = obj(
  {
    is_rfp: { type: B },
    title: { type: S },
    solicitation_number: { type: S },
    facts: obj(
      { agency: fact, scope: fact, contract_type: fact, contract_value: fact, work_location: fact, period_of_performance: fact, submission_method: fact },
      ["agency", "scope", "contract_type", "contract_value", "work_location", "period_of_performance", "submission_method"],
    ),
    deadlines: {
      type: A,
      items: obj(
        {
          kind: { type: S, enum: DeadlineKind.options },
          label: { type: S },
          date: { type: S, nullable: true },
          time: { type: S, nullable: true },
          timezone: { type: S, nullable: true },
          mandatory: { type: B },
          status,
          original_date: { type: S, nullable: true },
          revised_by: { type: S, nullable: true },
          note: { type: S, nullable: true },
          evidence,
        },
        ["kind", "label", "date", "mandatory", "status", "evidence"],
      ),
    },
    addenda: {
      type: A,
      items: obj(
        {
          label: { type: S },
          issued_date: { type: S, nullable: true },
          summary: { type: S },
          changes: { type: A, items: obj({ what: { type: S }, from: { type: S, nullable: true }, to: { type: S, nullable: true } }, ["what"]) },
          acknowledgement_required: { type: B },
          evidence,
        },
        ["label", "summary", "changes", "acknowledgement_required", "evidence"],
      ),
    },
    ambiguities,
  },
  ["is_rfp", "title", "solicitation_number", "facts", "deadlines", "addenda", "ambiguities"],
);

export const REQUIREMENTS_SCHEMA = obj(
  {
    requirements: {
      type: A,
      items: obj(
        {
          category: { type: S, enum: RequirementCategory.options },
          text: { type: S },
          values: { type: S, nullable: true },
          mandatory: { type: B },
          basis: { type: S, enum: ["explicit", "interpreted"] },
          evidence,
        },
        ["category", "text", "mandatory", "basis", "evidence"],
      ),
    },
    ambiguities,
  },
  ["requirements", "ambiguities"],
);

export const EVALUATION_SCHEMA = obj(
  {
    evaluation_criteria: {
      type: A,
      items: obj({ name: { type: S }, points: { type: N, nullable: true }, notes: { type: S, nullable: true }, evidence }, ["name", "evidence"]),
    },
    award_basis: fact,
    submission_items: {
      type: A,
      items: obj({ name: { type: S }, required: { type: B }, notes: { type: S, nullable: true }, evidence }, ["name", "required", "evidence"]),
    },
    contract_terms: {
      type: A,
      items: obj({ topic: { type: S }, text: { type: S }, evidence }, ["topic", "text", "evidence"]),
    },
  },
  ["evaluation_criteria", "award_basis", "submission_items", "contract_terms"],
);

/* ------------------------------ zod (validation) ------------------------------ */

const Ev = z.array(EvidenceSchema).default([]);
const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const isoLoose = z
  .string()
  .nullish()
  .transform((v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null));

export const ScheduleOut = z.object({
  is_rfp: z.boolean(),
  title: z.string(),
  solicitation_number: z.string(),
  facts: z.object({
    agency: FactSchema,
    scope: FactSchema,
    contract_type: FactSchema,
    contract_value: FactSchema,
    work_location: FactSchema,
    period_of_performance: FactSchema,
    submission_method: FactSchema,
  }),
  deadlines: z.array(
    z.object({
      kind: DeadlineKind,
      label: z.string(),
      date: iso.nullish(),
      time: z.string().nullish(),
      timezone: z.string().nullish(),
      mandatory: z.boolean().default(false),
      status: FieldStatus,
      original_date: isoLoose,
      revised_by: z.string().nullish(),
      note: z.string().nullish(),
      evidence: Ev,
    }),
  ),
  addenda: z
    .array(
      z.object({
        label: z.string(),
        issued_date: z.string().nullish(),
        summary: z.string(),
        changes: z.array(z.object({ what: z.string(), from: z.string().nullish(), to: z.string().nullish() })).default([]),
        acknowledgement_required: z.boolean().default(false),
        evidence: Ev,
      }),
    )
    .default([]),
  ambiguities: z.array(AmbiguitySchema).default([]),
});

export const RequirementsOut = z.object({
  requirements: z.array(
    z.object({
      category: RequirementCategory,
      text: z.string(),
      values: z.string().nullish(),
      mandatory: z.boolean(),
      basis: z.enum(["explicit", "interpreted"]).default("explicit"),
      evidence: Ev,
    }),
  ),
  ambiguities: z.array(AmbiguitySchema).default([]),
});

export const EvaluationOut = z.object({
  evaluation_criteria: z.array(z.object({ name: z.string(), points: z.number().nullish(), notes: z.string().nullish(), evidence: Ev })).default([]),
  award_basis: FactSchema,
  submission_items: z.array(z.object({ name: z.string(), required: z.boolean(), notes: z.string().nullish(), evidence: Ev })).default([]),
  contract_terms: z.array(z.object({ topic: z.string(), text: z.string(), evidence: Ev })).default([]),
});

export type ScheduleOutT = z.infer<typeof ScheduleOut>;
export type RequirementsOutT = z.infer<typeof RequirementsOut>;
export type EvaluationOutT = z.infer<typeof EvaluationOut>;

export interface WorkerSpec {
  id: WorkerId;
  task: (changes: ChangeStatement[]) => string;
  schema: object;
  validate: z.ZodTypeAny;
}

export const WORKERS: WorkerSpec[] = [
  { id: "schedule", task: scheduleTask, schema: SCHEDULE_SCHEMA, validate: ScheduleOut },
  { id: "requirements", task: () => REQUIREMENTS_TASK, schema: REQUIREMENTS_SCHEMA, validate: RequirementsOut },
  { id: "evaluation", task: () => EVALUATION_TASK, schema: EVALUATION_SCHEMA, validate: EvaluationOut },
];
