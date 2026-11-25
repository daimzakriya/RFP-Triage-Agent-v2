import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { buildReport } from "@/lib/analyze";
import { dateVariants, findDates } from "@/lib/dates";
import { findFixture } from "@/lib/fixtures";
import { cleanPageText, extractPdfPages, PdfInputError } from "@/lib/pdf";
import { decide, scoreFactors } from "@/lib/score";
import type { Deadline, ModelOutput, ReviewFlag } from "@/lib/schema";
import { DocumentIndex, fillMissingDeadlines, verifyDeadline, verifyEvidence } from "@/lib/verify";

let rfp1: string[];
let rfp2: string[];

beforeAll(async () => {
  rfp1 = (await extractPdfPages(new Uint8Array(await readFile("samples/Sample-RFP-1-Port-Alder-Permit-Automation.pdf")))).pages;
  rfp2 = (await extractPdfPages(new Uint8Array(await readFile("samples/Sample-RFP-2-Larkspur-County-Janitorial.pdf")))).pages;
});

describe("PDF extraction", () => {
  it("reads every page of both samples", () => {
    expect(rfp1).toHaveLength(17);
    expect(rfp2).toHaveLength(12);
  });
  it("removes seal/logo noise (runs of 1-2 character lines)", () => {
    expect(cleanPageText("TITLE\nC\nI\nT\nY\nO\nF\nNext line")).toBe("TITLE\nNext line");
    expect(rfp1[0]).not.toMatch(/\nC\nI\nT\nY\n/);
  });
  it("rejects files that are not PDFs", async () => {
    await expect(extractPdfPages(new TextEncoder().encode("hello, not a pdf"))).rejects.toBeInstanceOf(PdfInputError);
  });
});

describe("evidence verification", () => {
  it("verifies a real quote on the cited page", () => {
    const idx = new DocumentIndex(rfp1);
    expect(verifyEvidence(idx, { page: 5, quote: "Deadline for written questions December 11, 2026, 5:00 PM" }).check).toBe("verified");
  });
  it("tolerates curly quotes, dashes and line breaks", () => {
    const idx = new DocumentIndex(rfp1);
    expect(verifyEvidence(idx, { page: 11, quote: "amount of $420,000 for implementation (Phases 1-4) plus the first two years" }).check).toBe("verified");
  });
  it("corrects the page when the quote is on another page", () => {
    const idx = new DocumentIndex(rfp1);
    const v = verifyEvidence(idx, { page: 2, quote: "Deadline for written questions December 11, 2026" });
    expect(v.check).toBe("relocated");
    expect(v.page).toBe(5);
    expect(v.citedPage).toBe(2);
  });
  it("flags an invented quote as unverified", () => {
    const idx = new DocumentIndex(rfp1);
    expect(verifyEvidence(idx, { page: 9, quote: "Proposers must hold an active Top Secret facility clearance" }).check).toBe("unverified");
  });
  it("all evidence in both recorded fixture answers is found in the PDFs", () => {
    for (const pages of [rfp1, rfp2]) {
      const r = buildReport({ pages, fileName: "x.pdf", modelJson: findFixture(pages)!.json, model: { provider: "t", name: "t", latencyMs: 0 } });
      expect(r.evidence_stats.unverified).toBe(0);
      expect(r.evidence_stats.approximate).toBe(0);
    }
  });
});

describe("deadline checks", () => {
  const base: Deadline = { kind: "proposal_due", label: "Proposals due", date: "2027-01-08", time: "3:00 PM", timezone: "Pacific", mandatory: true, status: "stated", note: null, evidence: [{ page: 1, quote: "Proposals due January 8, 2027 January 15, 2027, 3:00 PM Pacific" }] };

  it("warns that a line shows a revised date when the model picks the struck-through one", () => {
    const flags: ReviewFlag[] = [];
    verifyDeadline(new DocumentIndex(rfp1), base, flags);
    expect(flags.some((f) => f.level === "info" && /January 15, 2027/.test(f.message))).toBe(true);
  });
  it("flags a date that is not written in the cited source", () => {
    const flags: ReviewFlag[] = [];
    const v = verifyDeadline(new DocumentIndex(rfp1), { ...base, date: "2027-01-22" }, flags);
    expect(v.needsReview).toBe(true);
    expect(flags.some((f) => f.level === "warning" && /January 22, 2027/.test(f.message))).toBe(true);
  });
  it("adds 'Not stated' rows for required dates the model omitted", () => {
    const filled = fillMissingDeadlines([base]);
    const site = filled.find((d) => d.kind === "site_visit")!;
    expect(site.status).toBe("not_stated");
    expect(site.date).toBeNull();
    expect(filled.map((d) => d.kind)).toEqual(expect.arrayContaining(["questions_due", "proposal_due", "site_visit", "work_start"]));
  });
  it("parses the common date formats", () => {
    expect(findDates("due January 8, 2027 January 15, 2027, 3:00 PM and 12/3/2026")).toEqual(["2027-01-08", "2027-01-15", "2026-12-03"]);
    expect(dateVariants("2026-12-03")).toContain("december 3, 2026");
  });
});

describe("scoring and decision", () => {
  const f = (id: any, points: number) => ({ id, points, reason: "r" });
  it("clamps points to each factor's maximum", () => {
    const { score } = scoreFactors([f("service_match", 9), f("team_fit", 2), f("eligibility", 2), f("commercial", 1), f("timeline", 1)]);
    expect(score).toBe(10);
  });
  it("caps the score at 2 when the work is not ours", () => {
    expect(scoreFactors([f("service_match", 0), f("team_fit", 2), f("eligibility", 2), f("commercial", 1), f("timeline", 1)]).score).toBe(2);
  });
  it("only bids when the score clears the bar, nothing is blocking and the model agrees", () => {
    const m = { recommendation: "BID", deal_breakers: [] } as unknown as ModelOutput;
    expect(decide(m, 7, 4).decision).toBe("BID");
    expect(decide(m, 5, 4).decision).toBe("NO_BID");
    expect(decide({ ...m, deal_breakers: [{ text: "x", severity: "blocking", evidence: [] }] }, 9, 4).decision).toBe("NO_BID");
    expect(decide({ ...m, recommendation: "NO_BID" }, 8, 4).decision).toBe("NO_BID");
    expect(decide(m, 8, 0)).toMatchObject({ decision: "NO_BID", fastNoBid: true });
  });
});

describe("full report on the samples (recorded model answers)", () => {
  it("Port Alder: BID, revised proposal date, addendum flagged, no site visit", () => {
    const r = buildReport({ pages: rfp1, fileName: "rfp1.pdf", modelJson: findFixture(rfp1)!.json, model: { provider: "t", name: "t", latencyMs: 0 } });
    expect(r.decision).toBe("BID");
    expect(r.deadlines.find((d) => d.kind === "proposal_due")!.date).toBe("2027-01-15");
    expect(r.deadlines.find((d) => d.kind === "site_visit")!.status).toBe("not_stated");
    expect(r.review_flags.some((x) => /addendum/i.test(x.message))).toBe(true);
    expect(r.reasons).toHaveLength(3);
  });
  it("Larkspur janitorial: fast NO_BID with mandatory site walk", () => {
    const r = buildReport({ pages: rfp2, fileName: "rfp2.pdf", modelJson: findFixture(rfp2)!.json, model: { provider: "t", name: "t", latencyMs: 0 } });
    expect(r).toMatchObject({ decision: "NO_BID", fastNoBid: true });
    expect(r.deadlines.find((d) => d.kind === "site_visit")).toMatchObject({ date: "2026-12-03", mandatory: true });
    expect(r.facts.contract_value.value).toBe("Not stated");
  });
  it("rejects a model answer that does not match the schema", () => {
    expect(() => buildReport({ pages: rfp1, fileName: "x", modelJson: { decision: "MAYBE" }, model: { provider: "t", name: "t", latencyMs: 0 } })).toThrow(/schema/);
  });
});

describe("requirement coverage safety net", () => {
  it("flags insurance and wage topics the model left out", async () => {
    const { checkRequirementCoverage } = await import("@/lib/verify");
    const f1 = checkRequirementCoverage(new DocumentIndex(rfp1), [{ text: "Small business set-aside; SOC 2; 3 years", evidence: [] }]);
    expect(f1.some((f) => /insurance/.test(f.message) && /12/.test(f.message))).toBe(true);
    const f2 = checkRequirementCoverage(new DocumentIndex(rfp2), [{ text: "5 years; bond; fingerprint background check; 5% price preference", evidence: [] }]);
    expect(f2.some((f) => /wage/.test(f.message))).toBe(true);
  });
  it("stays quiet when the recorded answers cover every topic", () => {
    for (const pages of [rfp1, rfp2]) {
      const r = buildReport({ pages, fileName: "x", modelJson: findFixture(pages)!.json, model: { provider: "t", name: "t", latencyMs: 0 } });
      expect(r.review_flags.filter((f) => f.field === "requirements")).toEqual([]);
    }
  });
});
