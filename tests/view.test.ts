import { describe, expect, it } from "vitest";
import { moneyIn, pageLimit, reqStatus } from "@/lib/view";

describe("view helpers", () => {
  it("maps compliance to a status a person can act on", () => {
    expect(reqStatus("compliant")).toBe("meets");
    expect(reqStatus("non_compliant")).toBe("fails");
    for (const c of ["partial", "unknown", "verify", undefined] as const) expect(reqStatus(c)).toBe("verify");
  });
  it("reads page limits from submission items", () => {
    expect(pageLimit("Proposal PDF (Tabs 1-8, max 30 pages)")).toBe(30);
    expect(pageLimit("Technical approach, no more than 12 pages")).toBe(12);
    expect(pageLimit("2-page cover letter")).toBe(2);
    expect(pageLimit("Attachment B: References")).toBeNull();
  });
  it("finds the contract value", () => {
    expect(moneyIn("Not-to-exceed $420,000 for implementation")).toBe("$420,000");
    expect(moneyIn("Up to $1.2 million over three years")).toBe("$1.2 million");
    expect(moneyIn("Not stated")).toBeNull();
  });
});
