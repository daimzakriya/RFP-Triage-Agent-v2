/**
 * Benchmark: runs the pipeline(s) on the sample RFPs, scores every run against
 * evals/expected.json (hand-checked ground truth), saves the full JSON reports
 * and prints a before/after comparison.
 *
 *   npm run bench                          v1 (baseline) vs v2 on both samples, live models
 *   npm run bench -- --samples=1           Port Alder only (saves quota)
 *   npm run bench -- --pipelines=v2        one pipeline
 *   npm run bench -- --fixture             offline, recorded answers (checks the plumbing, not the model)
 *   npm run eval                           = v2 only, exits non-zero if any check fails
 *
 * Results: evals/runs/<timestamp>/{<pipeline>-<sample>.json, summary.md}
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { analyzeDocument, buildReport, type PipelineVersion } from "../lib/analyze";
import { findFixture, v2Fixture } from "../lib/fixtures";
import { extractPdfPages } from "../lib/pdf";
import { setFixtureProvider } from "../lib/pipeline/llm";
import type { TriageReport } from "../lib/schema";

if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
process.env.LOG_QUIET = "1";

const arg = (name: string, dflt: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? dflt;
const evalMode = process.argv.includes("--eval");
const useFixture = process.argv.includes("--fixture");
const pipelines = arg("pipelines", evalMode ? "v2" : "v1,v2").split(",") as PipelineVersion[];
const expected = JSON.parse(readFileSync("evals/expected.json", "utf8")) as Record<string, any>;
const sampleFiles = Object.keys(expected).filter((k) => !k.startsWith("_"));
const pick = arg("samples", "1,2").split(",").map((n) => sampleFiles[Number(n) - 1]).filter(Boolean);
const outDir = `evals/runs/${new Date().toISOString().replace(/[:.]/g, "-")}${useFixture ? "-fixture" : ""}`;
mkdirSync(outDir, { recursive: true });

const has = (text: string, term: string) => term.toLowerCase().split("|").some((t) => text.includes(t));

interface Metrics {
  ok: boolean;
  error?: string;
  decision?: string;
  decisionCorrect?: boolean;
  score?: number;
  dates?: string; // "4/4"
  datesCorrect?: number;
  datesTotal?: number;
  addendum?: string; // "original+revised+label" or n/a
  reqRecall?: string;
  reqHits?: number;
  reqTotal?: number;
  missingReqs?: string[];
  evalRecall?: string;
  submissionRecall?: string;
  commercialRecall?: string;
  requirements?: number;
  evidence?: string;
  unverifiedRate?: number;
  quality?: string;
  calls?: number;
  input?: number;
  output?: number;
  thinking?: number;
  cached?: number;
  seconds?: number;
  checks: { pass: boolean; label: string; detail: string }[];
}

function score(r: TriageReport, exp: any, seconds: number): Metrics {
  const checks: Metrics["checks"] = [];
  const check = (pass: boolean, label: string, detail = "") => checks.push({ pass, label, detail });

  check(r.decision === exp.decision, "decision", r.decision);
  if (exp.minScore != null) check(r.fit_score >= exp.minScore, `fit score >= ${exp.minScore}`, String(r.fit_score));
  if (exp.maxScore != null) check(r.fit_score <= exp.maxScore, `fit score <= ${exp.maxScore}`, String(r.fit_score));
  if (exp.fastNoBid) check(r.fastNoBid, "fast no-bid");

  let datesCorrect = 0;
  const dEntries = Object.entries(exp.deadlines as Record<string, string | null>);
  for (const [kind, date] of dEntries) {
    const d = r.deadlines.find((x) => x.kind === kind);
    const okD = (d?.date ?? null) === date;
    if (okD) datesCorrect++;
    check(okD, `date ${kind}`, `got ${d?.date ?? "Not stated"}, want ${date ?? "Not stated"}`);
  }

  let addendum = "n/a";
  if (exp.addendum) {
    const d = r.deadlines.find((x) => x.kind === exp.addendum.deadline);
    const all = JSON.stringify(r).toLowerCase();
    const parts = [
      d?.date === exp.addendum.revised ? "revised" : "",
      (d?.original_date === exp.addendum.original || (d?.note ?? "").includes(exp.addendum.original.slice(0, 4)) && /january 8|2027-01-08/i.test(d?.note ?? "")) ? "original" : "",
      all.includes(exp.addendum.label) ? "label" : "",
    ].filter(Boolean);
    addendum = `${parts.length}/3 (${parts.join("+") || "none"})`;
    check(parts.length === 3, "addendum: original + revised date + addendum named", addendum);
  }

  const reqText = [
    ...r.requirements.map((q) => `${q.text} ${(q as any).values ?? ""} ${q.evidence.map((e) => e.quote).join(" ")}`),
  ].join(" ").toLowerCase();
  const missingReqs = (exp.requirementTerms as string[]).filter((t) => !has(reqText, t));
  const reqHits = exp.requirementTerms.length - missingReqs.length;
  check(missingReqs.length === 0, "requirement recall", `${reqHits}/${exp.requirementTerms.length}${missingReqs.length ? ` missing: ${missingReqs.join(", ")}` : ""}`);

  const crit = r.evaluation_criteria ?? [];
  const critHits = (exp.evaluationCriteria as { name: string; points: number }[]).filter((c) =>
    crit.some((x) => has(x.name.toLowerCase(), c.name) && x.points === c.points),
  ).length;
  const evalRecall = exp.evaluationCriteria.length ? `${critHits}/${exp.evaluationCriteria.length}` : exp.awardTerms ? (has((r.award_basis?.value ?? "").toLowerCase(), exp.awardTerms[0]) ? "award ok" : "award missing") : "n/a";
  if (exp.evaluationCriteria.length) check(critHits === exp.evaluationCriteria.length, "evaluation criteria (name + points)", evalRecall);
  if (exp.awardTerms) check(evalRecall === "award ok", "award basis", r.award_basis?.value ?? "not extracted");

  const subText = (r.submission_items ?? []).map((s) => `${s.name} ${s.notes ?? ""}`).join(" ").toLowerCase().replace(/forms (\d) and (\d)/g, "form $1 form $2");
  const subHits = (exp.submissionTerms as string[]).filter((t) => has(subText, t)).length;
  check(subHits === exp.submissionTerms.length, "submission items / attachments", `${subHits}/${exp.submissionTerms.length}`);

  const comText = [...(r.contract_terms ?? []).map((c) => `${c.topic} ${c.text}`), r.facts.contract_value.value, ...r.requirements.map((q) => q.text)].join(" ").toLowerCase();
  const comHits = (exp.commercialTerms as string[]).filter((t) => has(comText, t)).length;
  check(comHits === exp.commercialTerms.length, "commercial terms", `${comHits}/${exp.commercialTerms.length}`);

  const s = r.evidence_stats;
  check(s.unverified === 0, "all evidence quotes found in the PDF", `${s.verified}/${s.total} verified, ${s.unverified} not found`);
  check(seconds <= 120, "finished in reasonable time (<= 120 s)", `${seconds.toFixed(1)}s`);

  const u = r.usage;
  return {
    ok: true,
    decision: r.decision,
    decisionCorrect: r.decision === exp.decision,
    score: r.fit_score,
    dates: `${datesCorrect}/${dEntries.length}`,
    datesCorrect,
    datesTotal: dEntries.length,
    addendum,
    reqRecall: `${reqHits}/${exp.requirementTerms.length}`,
    reqHits,
    reqTotal: exp.requirementTerms.length,
    missingReqs,
    evalRecall,
    submissionRecall: `${subHits}/${exp.submissionTerms.length}`,
    commercialRecall: `${comHits}/${exp.commercialTerms.length}`,
    requirements: r.requirements.length,
    evidence: `${s.verified}/${s.total}`,
    unverifiedRate: s.total ? s.unverified / s.total : 0,
    quality: r.quality?.status ?? "n/a (v1)",
    calls: u?.calls,
    input: u?.input,
    output: u?.output,
    thinking: u?.thinking,
    cached: u?.cached,
    seconds,
    checks,
  };
}

const results: Record<string, Record<string, Metrics>> = {};
for (const file of pick) {
  const { pages } = await extractPdfPages(new Uint8Array(await readFile(file)));
  for (const p of pipelines) {
    const label = `${p} · ${file.split("/").pop()}`;
    process.stdout.write(`\n${label}\n`);
    const t0 = Date.now();
    let report: TriageReport;
    try {
      if (useFixture) {
        if (p === "v1") {
          const fx = findFixture(pages)!;
          report = { ...buildReport({ pages, fileName: file, modelJson: fx.json, model: { provider: "fixture", name: fx.name, latencyMs: 0 } }), pipeline: "v1" };
        } else {
          setFixtureProvider(v2Fixture);
          report = await analyzeDocument(pages, file, undefined, "v2");
          setFixtureProvider(null);
        }
      } else {
        report = await analyzeDocument(pages, file, undefined, p);
      }
    } catch (err) {
      const m: Metrics = { ok: false, error: (err as Error).message, checks: [{ pass: false, label: "analysis completed", detail: (err as Error).message.slice(0, 300) }] };
      (results[file] ??= {})[p] = m;
      console.log(`  FAIL  analysis completed  (${(err as Error).message.slice(0, 300)})`);
      continue;
    }
    const seconds = (Date.now() - t0) / 1000;
    writeFileSync(`${outDir}/${p}-${file.split("/").pop()!.replace(".pdf", "")}.json`, JSON.stringify(report, null, 2));
    const m = score(report, expected[file], seconds);
    (results[file] ??= {})[p] = m;
    console.log(`  ${report.decision}  fit ${report.fit_score}/10  quality ${m.quality}  via ${report.model.name}  ${seconds.toFixed(1)}s  ${m.calls ?? "?"} call(s)`);
    for (const c of m.checks) console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.label}${c.detail ? `  (${c.detail})` : ""}`);
    if (p === "v2" && report.quality) for (const q of report.quality.checks) if (q.status !== "pass") console.log(`  qc[${q.status}] ${q.label}: ${q.detail}`);
    if (pipelines.length > 1 && !useFixture) await new Promise((r) => setTimeout(r, 4000)); // be gentle with free-tier RPM
  }
}

/* ------------------------------ comparison ------------------------------ */
const rows: [string, (m: Metrics) => string][] = [
  ["Completed", (m) => (m.ok ? "yes" : `no: ${m.error?.slice(0, 60)}`)],
  ["Decision (correct?)", (m) => (m.ok ? `${m.decision} (${m.decisionCorrect ? "✓" : "✗"})` : "")],
  ["Fit score", (m) => String(m.score ?? "")],
  ["Key dates correct", (m) => m.dates ?? ""],
  ["Addendum (orig+revised+named)", (m) => m.addendum ?? ""],
  ["Mandatory-requirement recall (terms)", (m) => m.reqRecall ?? ""],
  ["Evaluation criteria (name+points)", (m) => m.evalRecall ?? ""],
  ["Submission items / attachments", (m) => m.submissionRecall ?? ""],
  ["Commercial terms", (m) => m.commercialRecall ?? ""],
  ["Requirements extracted", (m) => String(m.requirements ?? "")],
  ["Evidence verified", (m) => m.evidence ?? ""],
  ["Unverified-quote rate (hallucination proxy)", (m) => (m.unverifiedRate != null ? `${(m.unverifiedRate * 100).toFixed(1)}%` : "")],
  ["Quality status", (m) => m.quality ?? ""],
  ["Model calls", (m) => String(m.calls ?? "")],
  ["Input tokens (cached)", (m) => (m.input != null ? `${m.input} (${m.cached})` : "")],
  ["Output tokens", (m) => String(m.output ?? "")],
  ["Thinking tokens", (m) => String(m.thinking ?? "")],
  ["Time (s)", (m) => (m.seconds != null ? m.seconds.toFixed(1) : "")],
];
let md = `# Benchmark ${outDir.split("/").pop()}\n\n${useFixture ? "**Fixture mode: recorded answers, not live model output.**\n\n" : ""}`;
for (const [file, byP] of Object.entries(results)) {
  md += `## ${file.split("/").pop()}\n\n| Metric | ${pipelines.join(" | ")} |\n|---|${pipelines.map(() => "---").join("|")}|\n`;
  for (const [name, f] of rows) md += `| ${name} | ${pipelines.map((p) => (byP[p] ? f(byP[p]) : "—")).join(" | ")} |\n`;
  md += "\n";
}
writeFileSync(`${outDir}/summary.md`, md);
console.log(`\n${md}\nSaved full reports and summary to ${outDir}/`);

const failures = Object.values(results).flatMap((byP) => Object.values(byP)).flatMap((m) => m.checks.filter((c) => !c.pass)).length;
if (evalMode) {
  console.log(failures ? `${failures} check(s) failed.` : "All checks passed.");
  process.exit(failures ? 1 : 0);
}
