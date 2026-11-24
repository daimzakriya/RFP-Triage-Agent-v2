import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyzeDocument } from "@/lib/analyze";
import { collectFindings, locateAll, locateQuote, type TextRun } from "@/lib/evidence-map";
import { v2Fixture } from "@/lib/fixtures";
import { extractPdfPages } from "@/lib/pdf";
import { setFixtureProvider } from "@/lib/pipeline/llm";

let pages: string[];
let runs: TextRun[][];
beforeAll(async () => {
  const x = await extractPdfPages(new Uint8Array(await readFile("samples/Sample-RFP-1-Port-Alder-Permit-Automation.pdf")), { positions: true });
  pages = x.pages;
  runs = x.runs!;
});
afterAll(() => setFixtureProvider(null));

describe("evidence positions in the real sample PDF", () => {
  it("captures positioned text runs for every page, inside the page", () => {
    expect(runs).toHaveLength(pages.length);
    for (const page of runs) {
      expect(page.length).toBeGreaterThan(0);
      for (const r of page) {
        expect(r.x).toBeGreaterThanOrEqual(-0.01);
        expect(r.x + r.w).toBeLessThanOrEqual(1.01);
        expect(r.y).toBeGreaterThanOrEqual(-0.01);
        expect(r.y + r.h).toBeLessThanOrEqual(1.01);
      }
    }
  });

  it("pins the addendum sentence exactly on page 5, in the right region", () => {
    const q = "The proposal due date is extended from January 8, 2027 to January 15, 2027";
    const loc = locateQuote(runs[4], 5, q);
    expect(loc.confidence).toBe("exact");
    expect(loc.boxes.length).toBeGreaterThan(0);
    // the boxes cover text that really contains the date
    const covered = runs[4].filter((r) => loc.boxes.some((b) => Math.abs(r.y - b.y) < 0.005 && r.x < b.x + b.w && r.x + r.w > b.x));
    expect(covered.map((r) => r.s).join(" ")).toMatch(/January 15, 2027/);
  });

  it("matches across different whitespace, line breaks, curly quotes and hyphenation", () => {
    const fake: TextRun[] = [
      { s: "The Contractor shall main-", x: 0.1, y: 0.1, w: 0.4, h: 0.02 },
      { s: "tain “cyber liability” insurance of", x: 0.1, y: 0.13, w: 0.5, h: 0.02 },
      { s: "$2,000,000   per claim.", x: 0.1, y: 0.16, w: 0.3, h: 0.02 },
    ];
    const loc = locateQuote(fake, 1, 'maintain "cyber liability" insurance of $2,000,000 per claim');
    expect(loc.confidence).toBe("exact");
    expect(loc.boxes.length).toBe(3); // one per line
  });

  it("never highlights an unrelated passage", () => {
    const loc = locateQuote(runs[4], 5, "The vendor must hold a Top Secret facility clearance issued by the Department of Defense");
    expect(loc.confidence).toBe("none");
    expect(loc.boxes).toEqual([]);
    expect(loc.reason).toBeTruthy();
  });

  it("does not pin a short quote that appears more than once on the page", () => {
    const fake: TextRun[] = [
      { s: "Fee: $500", x: 0.1, y: 0.1, w: 0.2, h: 0.02 },
      { s: "Bond: $500", x: 0.1, y: 0.2, w: 0.2, h: 0.02 },
    ];
    expect(locateQuote(fake, 1, "$500").confidence).toBe("none");
    expect(locateQuote([fake[0]], 1, "$500").confidence).toBe("exact");
  });

  it("falls back to a strict close match when a few words differ", () => {
    const q = "The proposal due date is extended from January 8, 2027 until January 15, 2027";
    const loc = locateQuote(runs[4], 5, q);
    expect(loc.confidence).toBe("fuzzy");
    expect(loc.score).toBeGreaterThanOrEqual(0.85);
    expect(loc.boxes.length).toBeGreaterThan(0);
  });

  it("locates almost every finding of the real report exactly, and only verified ones", async () => {
    setFixtureProvider(v2Fixture);
    const report = await analyzeDocument(pages, "rfp1.pdf", undefined, "v2");
    const findings = collectFindings(report);
    const locs = locateAll(report, runs);
    expect(findings.length).toBeGreaterThan(30);
    const verified = findings.filter((f) => f.evidence.check === "verified" || f.evidence.check === "relocated");
    const exact = verified.filter((f) => locs[f.key].confidence === "exact");
    expect(exact.length / verified.length).toBeGreaterThan(0.9);
    // categories come from the finding type
    expect(findings.find((f) => /proposal/i.test(f.label) && f.category === "date")).toBeTruthy();
    expect(findings.some((f) => f.category === "evaluation")).toBe(true);
    expect(findings.some((f) => f.category === "contract")).toBe(true);
  });
});
