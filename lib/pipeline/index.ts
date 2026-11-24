/**
 * v2 pipeline: preprocess -> 3 parallel extraction workers -> deterministic
 * consolidation + evidence verification -> reasoning over the dataset ->
 * deterministic scoring caps -> quality checks.
 */
import { LlmError } from "../gemini";
import type { ComplianceStatus, FactKey, QualityCheck, ReviewFlag, TriageReport } from "../schema";
import { decide, scoreFactors } from "../score";
import {
  checkRequirementCoverage,
  DocumentIndex,
  fillMissingDeadlines,
  verifyDeadline,
  verifyEvidence,
  verifyItem,
} from "../verify";
import { applyComplianceCaps, mergeRequirements, reconcileDeadlines } from "./consolidate";
import { callTask, extractionModels, log, reasoningModels, sumUsage, type TaskResult } from "./llm";
import { findChangeStatements, mentionsAddenda, renderPages, routePages, type WorkerId } from "./preprocess";
import { ReasonOut, reasonSystem, reasonUser, REASON_SCHEMA, type ReasonOutT } from "./reason";
import {
  EXTRACTION_SYSTEM,
  extractionUser,
  WORKERS,
  type EvaluationOutT,
  type RequirementsOutT,
  type ScheduleOutT,
  type WorkerSpec,
} from "./workers";

interface WorkerRun<T> {
  id: WorkerId;
  ok: boolean;
  data?: T;
  attempts: number;
  error?: string;
  results: TaskResult[];
}

async function runWorker(spec: WorkerSpec, pages: string[], pageNumbers: number[], hintsTask: string, signal?: AbortSignal, extra = ""): Promise<WorkerRun<unknown>> {
  const user = extractionUser(renderPages(pages, pageNumbers), pages.length, hintsTask + extra);
  const results: TaskResult[] = [];
  let lastErr = "";
  // Retry only this task, once, on a provider error or a schema-invalid answer.
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (signal?.aborted) {
      lastErr = lastErr || "time budget for extraction used up";
      break;
    }
    try {
      const r = await callTask({ task: `extract.${spec.id}`, system: EXTRACTION_SYSTEM, user, schema: spec.schema, models: extractionModels(), thinkingLevel: "low", signal, allowBackup: false });
      results.push(r);
      const parsed = spec.validate.safeParse(r.json);
      if (parsed.success) return { id: spec.id, ok: true, data: parsed.data, attempts: attempt, results };
      const issue = parsed.error.issues[0];
      lastErr = `schema: ${issue.path.join(".")}: ${issue.message}`;
      log("worker.invalid", { worker: spec.id, attempt, error: lastErr });
    } catch (err) {
      lastErr = (err as Error).message;
      if (err instanceof LlmError && [429].includes(err.status) && attempt === 1) {
        // quota: retrying immediately won't help
        break;
      }
    }
  }
  return { id: spec.id, ok: false, attempts: 2, error: lastErr, results };
}

export async function runPipelineV2(pages: string[], fileName: string, signal?: AbortSignal): Promise<TriageReport> {
  const started = Date.now();
  const idx = new DocumentIndex(pages);
  const flags: ReviewFlag[] = [];
  const checks: QualityCheck[] = [];

  /* ---------- 0. deterministic preprocessing ---------- */
  const routing = routePages(pages);
  const changes = findChangeStatements(pages);
  log("pipeline.start", { fileName, pages: pages.length, estTokens: routing.totalTokens, fullDocument: routing.fullDocument, changeStatements: changes.length });

  /* ---------- 1. extraction workers (parallel) ---------- */
  // Hard time budget for the Gemini extraction phase, so that if the free models are
  // overloaded there is still time left (Vercel allows 300 s) for the backup call.
  const extractBudget = new AbortController();
  const budgetTimer = setTimeout(() => extractBudget.abort(), Number(process.env.EXTRACT_BUDGET_MS ?? 100_000));
  const onOuter = () => extractBudget.abort();
  signal?.addEventListener("abort", onOuter);
  let runs: WorkerRun<unknown>[];
  try {
    runs = await Promise.all(
      WORKERS.map((w) => runWorker(w, pages, routing.pagesByWorker[w.id], w.task(changes), extractBudget.signal)),
    );
  } finally {
    clearTimeout(budgetTimer);
    signal?.removeEventListener("abort", onOuter);
  }
  if (signal?.aborted) throw new LlmError("The analysis timed out.", 504);
  const byId = Object.fromEntries(runs.map((r) => [r.id, r])) as Record<WorkerId, WorkerRun<unknown>>;
  const failed = runs.filter((r) => !r.ok);
  if (!byId.schedule.ok || !byId.requirements.ok) {
    // Without dates or requirements there is no honest report to show.
    const why = failed.map((f) => `${f.id}: ${f.error}`).join("; ");
    const status = failed.every((f) => /quota|429/i.test(f.error ?? "")) ? 429 : 503;
    throw new LlmError(`The analysis could not be completed. Details: ${why}`, status);
  }
  const sched = byId.schedule.data as ScheduleOutT;
  let reqOut = byId.requirements.data as RequirementsOutT;
  const evalOut = byId.evaluation.ok ? (byId.evaluation.data as EvaluationOutT) : null;

  /* ---------- 1b. targeted re-extraction if requirement evidence is poor ---------- */
  const unverifiedShare = (r: RequirementsOutT) => {
    const evs = r.requirements.flatMap((q) => q.evidence.map((e) => verifyEvidence(idx, e)));
    return evs.length ? evs.filter((e) => e.check === "unverified").length / evs.length : 1;
  };
  if ((reqOut.requirements.length === 0 || unverifiedShare(reqOut) > 0.3) && Date.now() - started < 120_000) {
    const spec = WORKERS.find((w) => w.id === "requirements")!;
    const again = await runWorker(spec, pages, routing.pagesByWorker.requirements, spec.task(changes), signal,
      "\n\nIMPORTANT: a previous attempt cited quotes that are not in the document. Copy quotes character-for-character from the page text.");
    byId.requirements.results.push(...again.results);
    if (again.ok && unverifiedShare(again.data as RequirementsOutT) < unverifiedShare(reqOut)) reqOut = again.data as RequirementsOutT;
    flags.push({ level: "info", field: "requirements", message: "Requirements were re-extracted once because many source quotes could not be found." });
  }

  /* ---------- 2. deterministic consolidation ---------- */
  const reconciled = reconcileDeadlines(sched.deadlines, changes, flags);
  const deadlines = fillMissingDeadlines(reconciled as never)
    .map((d) => {
      const v = verifyDeadline(idx, d, flags);
      const r = d as (typeof reconciled)[number];
      return { what: d.label, ...v, original_date: r.original_date ?? null, revised_by: r.revised_by ?? null };
    })
    .sort((a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999"));

  const facts = Object.fromEntries(
    (Object.keys(sched.facts) as FactKey[]).map((k) => [k, verifyItem(idx, sched.facts[k], `facts.${k}`, flags)]),
  ) as TriageReport["facts"];

  const { merged, duplicatesRemoved } = mergeRequirements(reqOut.requirements);
  const verifiedReqs = merged.map((r) => ({ ...verifyItem(idx, r, `requirements.${r.id}`, flags), id: r.id }));

  const ambiguities = [...sched.ambiguities, ...reqOut.ambiguities].map((a, i) => verifyItem(idx, a, `ambiguities[${i}]`, flags));
  for (const a of ambiguities) flags.push({ level: "warning", field: "ambiguity", message: a.text });

  const addenda = sched.addenda.map((a) => {
    const evidence = a.evidence.map((e) => verifyEvidence(idx, e));
    const confirmed = changes.some((c) => c.addendum && normalize(c.addendum) === normalize(a.label)) || evidence.some((e) => e.check !== "unverified");
    return { label: a.label, issued_date: a.issued_date ?? null, summary: a.summary, changes: a.changes.map((c) => ({ what: c.what, from: c.from ?? null, to: c.to ?? null })), acknowledgement_required: a.acknowledgement_required, evidence, confirmed };
  });

  const evaluation_criteria = (evalOut?.evaluation_criteria ?? []).map((c, i) => verifyItem(idx, { ...c, points: c.points ?? null, notes: c.notes ?? null }, `evaluation[${i}]`, flags));
  const submission_items = (evalOut?.submission_items ?? []).map((c, i) => verifyItem(idx, { ...c, notes: c.notes ?? null }, `submission[${i}]`, flags));
  const contract_terms = (evalOut?.contract_terms ?? []).map((c, i) => verifyItem(idx, c, `contract_terms[${i}]`, flags));
  const award_basis = evalOut ? verifyItem(idx, evalOut.award_basis, "award_basis", flags) : undefined;

  /* ---------- 3. reasoning over the full dataset ---------- */
  const dataset = {
    title: sched.title,
    solicitation_number: sched.solicitation_number,
    is_rfp: sched.is_rfp,
    facts: Object.fromEntries(Object.entries(facts).map(([k, f]) => [k, f.value])),
    deadlines: deadlines.map((d) => ({ kind: d.kind, label: d.label, date: d.date, original_date: d.original_date, revised_by: d.revised_by, mandatory: d.mandatory, time: d.time, timezone: d.timezone })),
    addenda: addenda.map((a) => ({ label: a.label, summary: a.summary, changes: a.changes, acknowledgement_required: a.acknowledgement_required })),
    requirements: verifiedReqs.map((r) => ({
      id: r.id,
      category: r.category,
      mandatory: r.mandatory,
      text: r.text,
      values: r.values ?? null,
      pages: [...new Set(r.evidence.map((e) => e.page))],
      evidence_verified: r.evidence.some((e) => e.check === "verified" || e.check === "relocated"),
    })),
    evaluation_criteria: evaluation_criteria.map((c) => ({ name: c.name, points: c.points })),
    award_basis: award_basis?.value ?? "Not stated",
    contract_terms: contract_terms.map((c) => ({ topic: c.topic, text: c.text })),
    ambiguities: ambiguities.map((a) => a.text),
  };

  let reason: ReasonOutT | null = null;
  const reasonResults: TaskResult[] = [];
  let reasonError = "";
  for (let attempt = 1; attempt <= 2 && !reason; attempt++) {
    try {
      const r = await callTask({ task: "reason", system: reasonSystem(), user: reasonUser(dataset), schema: REASON_SCHEMA, models: reasoningModels(), thinkingLevel: "medium", signal });
      reasonResults.push(r);
      const p = ReasonOut.safeParse(r.json);
      if (p.success) reason = p.data;
      else reasonError = `schema: ${p.error.issues[0].path.join(".")}: ${p.error.issues[0].message}`;
    } catch (err) {
      reasonError = (err as Error).message;
      if (err instanceof LlmError && err.status === 429) break;
    }
  }
  if (!reason) throw new LlmError(`The bid/no-bid reasoning step failed. Details: ${reasonError}`, /quota|429/i.test(reasonError) ? 429 : 503);

  /* ---------- 4. deterministic scoring ---------- */
  const statusById = new Map(reason.compliance.map((c) => [c.id, c]));
  const requirements = verifiedReqs.map((r) => {
    const c = statusById.get(r.id);
    return { ...r, compliance: (c?.status ?? "unknown") as ComplianceStatus, compliance_reason: c?.reason ?? "Not assessed by the model." };
  });
  const missingAssessments = verifiedReqs.filter((r) => !statusById.has(r.id)).map((r) => r.id);

  const base = scoreFactors(reason.fit_factors);
  const capped = applyComplianceCaps(base.scored, requirements);
  let score = Math.round(capped.factors.reduce((n, f) => n + f.points, 0) * 10) / 10;
  const service = capped.factors.find((f) => f.id === "service_match")!.points;
  if (service === 0) score = Math.min(score, 2);

  // Deal-breakers: model's, plus any mandatory non_compliant requirement it didn't list.
  const deal = reason.deal_breakers.map((d) => ({
    text: d.text,
    severity: d.severity,
    evidence: requirements.filter((r) => d.requirement_ids.includes(r.id)).flatMap((r) => r.evidence).slice(0, 3),
  }));
  for (const r of requirements.filter((x) => x.mandatory && x.compliance === "non_compliant")) {
    if (!reason.deal_breakers.some((d) => d.requirement_ids.includes(r.id))) {
      deal.push({ text: `${r.id}: ${r.text}`, severity: "blocking", evidence: r.evidence });
    }
  }
  const deal_breakers = deal.map((d, i) => ({ ...d, needsReview: d.evidence.some((e) => e.check === "unverified"), evidence: d.evidence }));
  const modelLike = { recommendation: reason.recommendation, deal_breakers: deal.map((d) => ({ ...d, evidence: [] })) };
  const decision = decide(modelLike as never, score, service);
  const decisionNote = [decision.note, ...capped.notes].filter(Boolean).join(" ") || null;

  flags.push(...checkRequirementCoverage(idx, requirements));

  /* ---------- 5. quality checks ---------- */
  const allExtraction = runs.flatMap((r) => r.results);
  const evidenceAll = [
    ...Object.values(facts).flatMap((f) => f.evidence),
    ...deadlines.flatMap((d) => d.evidence),
    ...requirements.flatMap((r) => r.evidence),
    ...evaluation_criteria.flatMap((c) => c.evidence),
    ...submission_items.flatMap((c) => c.evidence),
    ...contract_terms.flatMap((c) => c.evidence),
  ];
  const ok = (e: { check: string }) => e.check === "verified" || e.check === "relocated";
  const mandatoryNoEvidence = requirements.filter((r) => r.mandatory && !r.evidence.some(ok));
  const datesUncited = deadlines.filter((d) => d.date && !d.evidence.some(ok));
  const unsupported = [...requirements, ...evaluation_criteria, ...submission_items].filter((x) => x.evidence.length && x.evidence.every((e) => e.check === "unverified"));
  const covered = new Set(Object.values(routing.pagesByWorker).flat());
  const docHasAddenda = mentionsAddenda(pages);
  const scheduleChangeUnapplied = changes.filter((c) => !deadlines.some((d) => d.date === c.to));
  const consistent =
    (decision.decision === "NO_BID" || (!requirements.some((r) => r.mandatory && r.compliance === "non_compliant") && !deal.some((d) => d.severity === "blocking"))) &&
    score >= 0 && score <= 10;

  const add = (id: string, label: string, status: QualityCheck["status"], detail: string) => checks.push({ id, label, status, detail });
  add("pages", "Every page was read", covered.size === pages.length ? "pass" : "fail", `${covered.size}/${pages.length} pages sent to extraction${routing.fullDocument ? " (whole document to each task)" : " (section-routed)"}`);
  add("tasks", "All extraction tasks completed", failed.length ? "warn" : "pass", failed.length ? `Failed: ${failed.map((f) => `${f.id} (${f.error})`).join("; ")}` : `${runs.length}/${runs.length} tasks, ${allExtraction.length} model calls`);
  add("schema", "Model output matched the schema", "pass", "All accepted outputs validated with zod");
  add("mandatory_evidence", "Mandatory requirements have verified evidence", mandatoryNoEvidence.length ? "warn" : "pass", mandatoryNoEvidence.length ? `No verified quote for ${mandatoryNoEvidence.map((r) => r.id).join(", ")}` : `${requirements.filter((r) => r.mandatory).length} mandatory requirements, all with verified quotes`);
  add("dates", "Dates have page references", datesUncited.length ? "warn" : "pass", datesUncited.length ? `Unverified: ${datesUncited.map((d) => d.label).join(", ")}` : `${deadlines.filter((d) => d.date).length} dated events, all cited`);
  add("addenda", "Addenda evaluated", !docHasAddenda ? "pass" : scheduleChangeUnapplied.length ? "fail" : "pass", !docHasAddenda ? "No addenda mentioned" : scheduleChangeUnapplied.length ? `Change statement(s) not applied: ${scheduleChangeUnapplied.map((c) => `p.${c.page}`).join(", ")}` : `${addenda.length} addend${addenda.length === 1 ? "um" : "a"} reported; ${changes.length} explicit change statement(s) applied`);
  add("unsupported", "No unsupported items", unsupported.length ? "warn" : "pass", unsupported.length ? `${unsupported.length} item(s) whose quotes were not found in the PDF` : "Every item's quote was found in the PDF");
  add("ambiguities", "Contradictions surfaced, not discarded", "pass", `${ambiguities.length} ambiguit${ambiguities.length === 1 ? "y" : "ies"} reported`);
  add("assessed", "Every requirement assessed", missingAssessments.length ? "warn" : "pass", missingAssessments.length ? `Not assessed: ${missingAssessments.join(", ")} (treated as unknown)` : `${requirements.length} requirements assessed`);
  add("decision", "Decision consistent with findings", consistent ? "pass" : "fail", consistent ? `Score ${score}/10; ${decision.decision}` : "A BID was produced despite a non-compliant mandatory requirement");
  if (duplicatesRemoved) flags.push({ level: "info", field: "requirements", message: `${duplicatesRemoved} duplicate requirement(s) merged.` });
  const qStatus = checks.some((c) => c.status === "fail") ? "incomplete" : checks.some((c) => c.status === "warn") ? "needs_review" : "verified";

  /* ---------- assemble ---------- */
  const allResults = [...allExtraction, ...reasonResults];
  const usage = sumUsage(allResults);
  const evStats = {
    total: evidenceAll.length,
    verified: evidenceAll.filter(ok).length,
    approximate: evidenceAll.filter((e) => e.check === "approximate").length,
    unverified: evidenceAll.filter((e) => e.check === "unverified").length,
  };
  const providers = [...new Set(allResults.map((r) => r.provider))];
  const models = [...new Set(allResults.map((r) => r.model))];
  const ms = Date.now() - started;
  log("pipeline.done", { fileName, ms, calls: allResults.length, ...usage, decision: decision.decision, score, quality: qStatus });

  return {
    schemaVersion: "1.0",
    pipeline: "v2",
    generatedAt: new Date().toISOString(),
    document: { fileName, pageCount: pages.length, characters: pages.reduce((n, p) => n + p.length, 0), truncated: false },
    model: { provider: providers.join(" + "), name: models.join(", "), latencyMs: ms },
    decision: decision.decision,
    fastNoBid: decision.fastNoBid,
    modelRecommendation: reason.recommendation,
    decisionNote,
    fit_score: score,
    fit_factors: capped.factors,
    title: sched.title,
    solicitation_number: sched.solicitation_number,
    summary: reason.summary,
    facts,
    deadlines,
    requirements,
    reasons: reason.reasons.slice(0, 3),
    change_mind: reason.change_mind,
    deal_breakers,
    open_questions: reason.open_questions,
    ambiguities,
    review_flags: flags,
    evidence_stats: evStats,
    addenda,
    evaluation_criteria,
    award_basis,
    submission_items,
    contract_terms,
    quality: { status: qStatus, checks },
    usage: {
      calls: allResults.length,
      ...usage,
      ms,
      byTask: allResults.map((r) => ({ task: r.task, model: r.model, provider: r.provider, ms: r.latencyMs, ...r.usage })),
    },
  };
}

function normalize(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
