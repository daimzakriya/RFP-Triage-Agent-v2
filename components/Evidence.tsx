"use client";

import { createContext, useContext } from "react";
import { CATEGORY_INFO, evidenceKey, type HighlightCategory } from "@/lib/evidence-map";
import type { VerifiedEvidence } from "@/lib/schema";

/** Opens the original PDF at the cited page with the quote highlighted. */
export const SourceContext = createContext<(ev: VerifiedEvidence) => void>(() => {});
/** Highlight category of each quoted finding ("page|quote" → category), set by the report. */
export const CategoryContext = createContext<Map<string, HighlightCategory>>(new Map());

const CHECK_TEXT: Record<VerifiedEvidence["check"], string> = {
  verified: "Quote found on this page",
  relocated: "Quote found (page corrected)",
  approximate: "Close match only: check the source",
  unverified: "Quote NOT found in the document: check manually",
};
const ICON: Record<VerifiedEvidence["check"], string> = {
  verified: "✓",
  relocated: "✓",
  approximate: "≈",
  unverified: "!",
};

export function EvidenceList({ evidence }: { evidence: VerifiedEvidence[] }) {
  const open = useContext(SourceContext);
  const categories = useContext(CategoryContext);
  if (!evidence.length) return null;
  return (
    <span className="ev">
      {evidence.map((e, i) => {
        const cat = categories.get(evidenceKey(e));
        return (
        <button
          key={i}
          type="button"
          className={`ev-btn ${e.check === "relocated" ? "verified" : e.check}`}
          title={`${CHECK_TEXT[e.check]}: “${e.quote}”. Click to see it highlighted in the PDF.`}
          aria-label={`Source page ${e.page}. ${CHECK_TEXT[e.check]}. Open the PDF at this passage.`}
          onClick={() => open(e)}
        >
          {cat && <span className="ev-dot" style={{ background: CATEGORY_INFO[cat].color }} aria-hidden="true" />}
          p.{e.page} {ICON[e.check]}
        </button>
        );
      })}
    </span>
  );
}
