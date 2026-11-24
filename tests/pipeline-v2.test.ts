import { readFile } from "node:fs/promises";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { analyzeDocument } from "@/lib/analyze";
import { v2Fixture } from "@/lib/fixtures";
import { extractPdfPages } from "@/lib/pdf";
import { applyComplianceCaps, mergeRequirements, reconcileDeadlines } from "@/lib/pipeline/consolidate";
import { setFixtureProvider } from "@/lib/pipeline/llm";
import { findChangeStatements, routePages } from "@/lib/pipeline/preprocess";
import type { ReviewFlag } from "@/lib/schema";

let rfp1: string[];
let rfp2: string[];
beforeAll(async () => {
  rfp1 = (await extractPdfPages(new Uint8Array(await readFile("samples/Sample-RFP-1-Port-Alder-Permit-Automation.pdf")))).pages;
  rfp2 = (await extractPdfPages(new Uint8Array(await readFile("samples/Sample-RFP-2-Larkspur-County-Janitorial.pdf")))).pages;
});
afterEach(() => setFixtureProvider(null));

describe("addendum scanner", () => {
  it("finds the explicit change statement and its addendum", () => {
    const c = findChangeStatements(rfp1);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ page: 5, from: "2027-01-08", to: "2027-01-15", addendum: "Addendum No. 1" });
    expect(c[0].quote).toBe("The proposal due date is extended from January 8, 2027 to January 15, 2027");
  });
  it("works on other wording and numeric dates", () => {
    const c = findChangeStatements(["Amendment No. 2. The mandatory site visit is rescheduled from 3/4/2027 to 3/11/2027 at 9 AM."]);
    expect(c[0]).toMatchObject({ from: "2027-03-04", to: "2027-03-11", addendum: "Amendment No. 2" });
  });
  it("does NOT treat a later date elsewhere as a revision", () => {
    expect(findChangeStatements(["Proposals due January 8, 2027.", "Contract start February 1, 2027. Award from the Board on January 12, 2027."])).toEqual([]);
    expect(findChangeStatements(rfp2)).toEqual([]);
  });
});

describe("routing", () => {
  it("sends small documents whole to every worker", () => {
    const r = routePages(rfp1);
    expect(r.fullDocument).toBe(true);
    expect(r.pagesByWorker.requirements).toHaveLength(17);
  });
  it("routes long documents by section but still covers every page", () => {
    const filler = Array.from({ length: 80 }, (_, i) => (i % 7 === 0 ? "The Contractor shall maintain insurance and must be registered. " : "General background narrative about the city. ").repeat(60));
    const r = routePages(filler, 10_000);
    expect(r.fullDocument).toBe(false);
    expect(r.uncoveredPages).toEqual([]);
    expect(new Set(Object.values(r.pagesByWorker).flat()).size).toBe(80);
  });
});

describe("consolidation", () => {
  it("merges duplicate requirements and keeps all evidence", () => {
    const ev = (page: number, quote: string) => [{ page, quote }];
    const { merged, duplicatesRemoved } = mergeRequirements([
      { category: "insurance_bonding", text: "Cyber liability insurance of $2,000,000 per claim", values: "$2,000,000", mandatory: true, basis: "explicit", evidence: ev(12, "Cyber liability $2,000,000 per claim") },
      { category: "insurance_bonding", text: "Cyber liability insurance, $2,000,000 per claim, including breach response", values: null, mandatory: false, basis: "explicit", evidence: ev(12, "including data breach response") },
      { category: "accessibility", text: "WCAG 2.1 AA", values: null, mandatory: true, basis: "explicit", evidence: ev(7, "WCAG 2.1 Level AA") },
    ]);
    expect(duplicatesRemoved).toBe(1);
    expect(merged).toHaveLength(2);
    const ins = merged.find((r) => r.category === "insurance_bonding")!;
    expect(ins.mandatory).toBe(true);
    expect(ins.evidence).toHaveLength(2);
    expect(merged.map((r) => r.id)).toEqual(["R1", "R2"]);
  });
  it("keeps distinct requirements that share most words apart", () => {
    const ev = (q: string) => [{ page: 12, quote: q }];
    const { merged } = mergeRequirements([
      { category: "insurance_bonding", text: "Professional liability $2,000,000 per claim", values: null, mandatory: true, basis: "explicit", evidence: ev("Professional liability (errors and omissions) $2,000,000 per claim") },
      { category: "insurance_bonding", text: "Cyber liability $2,000,000 per claim", values: null, mandatory: true, basis: "explicit", evidence: ev("Cyber liability, including data breach response $2,000,000 per claim") },
    ]);
    expect(merged).toHaveLength(2);
  });

  const dl = (date: string, extra = {}) => ({ kind: "proposal_due" as const, label: "Proposals due", date, mandatory: true, status: "stated" as const, original_date: null as string | null, evidence: [], ...extra });
  const changes = [{ page: 5, quote: "extended from January 8, 2027 to January 15, 2027", from: "2027-01-08", to: "2027-01-15", addendum: "Addendum No. 1" }];

  it("corrects a superseded date only when a change statement proves it, keeping both dates", () => {
    const flags: ReviewFlag[] = [];
    const [d] = reconcileDeadlines([dl("2027-01-08")], changes, flags);
    expect(d).toMatchObject({ date: "2027-01-15", original_date: "2027-01-08", revised_by: "Addendum No. 1" });
    expect(flags[0].level).toBe("warning");
  });
  it("confirms a revision the model reported correctly", () => {
    const flags: ReviewFlag[] = [];
    const [d] = reconcileDeadlines([dl("2027-01-15", { original_date: "2027-01-08", revised_by: "Addendum No. 1" })], changes, flags);
    expect(d.date).toBe("2027-01-15");
    expect(flags[0]).toMatchObject({ level: "info" });
  });
  it("flags a revision the model claims without textual evidence", () => {
    const flags: ReviewFlag[] = [];
    const [d] = reconcileDeadlines([dl("2027-01-22", { original_date: "2027-01-15" })], changes, flags);
    expect(d.date).toBe("2027-01-22");
    expect(flags[0].message).toMatch(/Human verification/);
  });
  it("caps eligibility when mandatory eligibility items are unconfirmed, and zeroes it on a failure", () => {
    const f = [{ id: "eligibility" as const, label: "Eligibility", max: 2, points: 2, reason: "r" }];
    const req = (id: string, compliance: any, category: any = "past_performance") => ({ id, category, text: "t", mandatory: true, basis: "explicit" as const, evidence: [], compliance });
    expect(applyComplianceCaps(f, [req("R1", "unknown")]).factors[0].points).toBe(1.5);
    expect(applyComplianceCaps(f, [req("R1", "unknown"), req("R2", "verify"), req("R3", "partial")]).factors[0].points).toBe(1);
    expect(applyComplianceCaps(f, [req("R1", "non_compliant", "technical")]).factors[0].points).toBe(0);
    expect(applyComplianceCaps(f, [req("R1", "compliant")]).factors[0].points).toBe(2);
  });
});

describe("v2 pipeline end to end (recorded answers)", () => {
  it("Port Alder: BID, both proposal dates kept, addendum confirmed, all quality checks pass", async () => {
    setFixtureProvider(v2Fixture);
    const r = await analyzeDocument(rfp1, "rfp1.pdf", undefined, "v2");
    expect(r.pipeline).toBe("v2");
    expect(r.decision).toBe("BID");
    expect(r.deadlines.find((d) => d.kind === "proposal_due")).toMatchObject({ date: "2027-01-15", original_date: "2027-01-08", revised_by: "Addendum No. 1" });
    expect(r.addenda?.[0]).toMatchObject({ label: "Addendum No. 1", confirmed: true, acknowledgement_required: true });
    expect(r.evaluation_criteria?.map((c) => c.points)).toEqual([30, 20, 20, 15, 10, 5, 25]);
    expect(r.requirements.every((q) => /^R\d+$/.test(q.id!) && q.compliance)).toBe(true);
    expect(r.quality?.status).toBe("verified");
    expect(r.usage?.calls).toBe(4);
  });
  it("Larkspur: fast NO_BID with non-compliant mandatory items turned into blocking deal-breakers", async () => {
    setFixtureProvider(v2Fixture);
    const r = await analyzeDocument(rfp2, "rfp2.pdf", undefined, "v2");
    expect(r).toMatchObject({ decision: "NO_BID", fastNoBid: true });
    expect(r.deal_breakers.some((d) => d.severity === "blocking")).toBe(true);
    expect(r.fit_factors.find((f) => f.id === "eligibility")!.points).toBe(0);
    expect(r.submission_items).toHaveLength(6);
  });
  it("retries only the failed worker once when its answer breaks the schema", async () => {
    const calls: string[] = [];
    let broke = false;
    setFixtureProvider((task, user) => {
      calls.push(task);
      if (task === "extract.evaluation" && !broke) {
        broke = true;
        return { evaluation_criteria: "not a list" };
      }
      return v2Fixture(task, user);
    });
    const r = await analyzeDocument(rfp1, "rfp1.pdf", undefined, "v2");
    expect(calls.filter((t) => t === "extract.evaluation")).toHaveLength(2);
    expect(calls.filter((t) => t === "extract.schedule")).toHaveLength(1);
    expect(r.evaluation_criteria).toHaveLength(7);
  });
  it("never presents a partial AI report as complete when requirements could not be extracted", async () => {
    setFixtureProvider((task, user) => (task === "extract.requirements" ? { nope: true } : v2Fixture(task, user)));
    const r = await analyzeDocument(rfp1, "rfp1.pdf", undefined, "v2");
    expect(r.degraded).toBe(true);
    expect(r.decision).toBe("UNDETERMINED");
    expect(r.quality?.status).toBe("incomplete");
    expect(r.degradedReason).toMatch(/requirements: schema/);
  });
  it("flags invented requirements (quotes not in the PDF) instead of hiding them", async () => {
    setFixtureProvider((task, user) => {
      const base = v2Fixture(task, user) as any;
      if (task !== "extract.requirements") return base;
      return { ...base, requirements: [...base.requirements, { category: "security_clearance", text: "Top Secret facility clearance", values: null, mandatory: true, basis: "explicit", evidence: [{ page: 9, quote: "Proposers must hold an active Top Secret facility clearance" }] }] };
    });
    const r = await analyzeDocument(rfp1, "rfp1.pdf", undefined, "v2");
    const fake = r.requirements.find((q) => /Top Secret/.test(q.text))!;
    expect(fake.needsReview).toBe(true);
    expect(r.quality?.checks.find((c) => c.id === "unsupported")?.status).toBe("warn");
    expect(r.quality?.status).not.toBe("verified");
  });
});

describe("degraded mode (every AI provider unavailable)", () => {
  it("returns an honest text-search report instead of an error", async () => {
    const { vi } = await import("vitest");
    process.env.GEMINI_API_KEY = "k";
    process.env.GEMINI_RETRY_BUDGET_MS = "0";
    delete process.env.FALLBACK_API_KEY;
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":{"message":"This model is currently experiencing high demand."}}', { status: 503 })));
    const r = await analyzeDocument(rfp1, "rfp1.pdf", undefined, "v2");
    vi.unstubAllGlobals();
    delete process.env.GEMINI_RETRY_BUDGET_MS;
    expect(r.degraded).toBe(true);
    expect(r.decision).toBe("UNDETERMINED");
    expect(r.quality?.status).toBe("incomplete");
    expect(r.deadlines.find((d) => d.kind === "proposal_due")).toMatchObject({ date: "2027-01-15", original_date: "2027-01-08" });
    expect(r.deadlines.find((d) => d.kind === "questions_due")?.date).toBe("2026-12-11");
    expect(r.evidence_stats.unverified).toBe(0);
    expect(r.title).toBe("AI-Assisted Permit Intake and Review Automation Platform");
  });
  it("still finds a mandatory site walk without AI", async () => {
    const { buildOfflineReport } = await import("@/lib/pipeline/offline");
    const r = buildOfflineReport(rfp2, "rfp2.pdf", "test");
    expect(r.deadlines.find((d) => d.kind === "site_visit")).toMatchObject({ date: "2026-12-03", mandatory: true });
    expect(r.decisionNote).toMatch(/outside idiaz.io's services/);
  });
});

describe("backup provider budget", () => {
  it("sends the backup ONE whole-document request when Gemini can't run the pipeline", async () => {
    const { vi } = await import("vitest");
    const rfp1Model = (await import("@/fixtures/sample-rfp-1.model.json")).default;
    process.env.GEMINI_API_KEY = "k";
    process.env.FALLBACK_API_KEY = "m";
    process.env.GEMINI_RETRY_BUDGET_MS = "0";
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("googleapis")
        ? new Response('{"error":{"message":"This model is currently experiencing high demand."}}', { status: 503 })
        : new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(rfp1Model) } }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const r = await analyzeDocument(rfp1, "rfp1.pdf", undefined, "v2");
    vi.unstubAllGlobals();
    delete process.env.FALLBACK_API_KEY;
    delete process.env.GEMINI_RETRY_BUDGET_MS;
    const backupCalls = fetchMock.mock.calls.filter(([u]) => !String(u).includes("googleapis")).length;
    expect(backupCalls).toBe(1);
    expect(r.degraded).toBeFalsy();
    expect(r.decision).toBe("BID");
    expect(r.model.provider).toMatch(/backup, single call/);
    expect(r.deadlines.find((d) => d.kind === "proposal_due")?.date).toBe("2027-01-15");
  });
});
