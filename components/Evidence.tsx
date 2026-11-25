"use client";

import { createContext, useContext, useId } from "react";
import { CATEGORY_INFO, evidenceKey, type HighlightCategory } from "@/lib/evidence-map";
import type { VerifiedEvidence } from "@/lib/schema";

/** Opens the original PDF at the cited page with the quote highlighted. */
export const SourceContext = createContext<(ev: VerifiedEvidence) => void>(() => {});
/** Highlight category of each quoted finding ("page|quote" → category), set by the report. */
export const CategoryContext = createContext<Map<string, HighlightCategory>>(new Map());

const STATE: Record<VerifiedEvidence["check"], { word: string; tip: string; cls: string }> = {
  verified: { word: "", tip: "Found word for word on this page", cls: "ok" },
  relocated: { word: "", tip: "Found word for word (page number corrected)", cls: "ok" },
  approximate: { word: "close match", tip: "Only a close match was found. Read the passage to confirm", cls: "near" },
  unverified: { word: "not found", tip: "This quote isn't in the document. Check it by hand", cls: "miss" },
};

function Check({ ok }: { ok: boolean }) {
  return ok ? (
    <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
  ) : (
    <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7v6M12 17h.01" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" /></svg>
  );
}

function Source({ e }: { e: VerifiedEvidence }) {
  const open = useContext(SourceContext);
  const cat = useContext(CategoryContext).get(evidenceKey(e));
  const tipId = useId();
  const st = STATE[e.check];
  const color = cat ? CATEGORY_INFO[cat].color : undefined;
  return (
    <span className="src">
      <button
        type="button"
        className={`src-btn ${st.cls}`}
        style={color ? ({ ["--cat" as string]: color } as React.CSSProperties) : undefined}
        aria-describedby={tipId}
        aria-label={`Open page ${e.page} of the PDF with this passage highlighted. ${st.tip}.`}
        onClick={(ev) => {
          ev.stopPropagation();
          open(e);
        }}
      >
        <span className="src-ink" aria-hidden="true" />
        p.{e.page}
        {st.word && <span className="src-word">{st.word}</span>}
        <Check ok={st.cls === "ok"} />
      </button>
      <span className="src-pop" role="tooltip" id={tipId}>
        <span className="src-pop-head">
          {cat && <span className="src-pop-cat" style={{ ["--cat" as string]: color } as React.CSSProperties}>{CATEGORY_INFO[cat].label}</span>}
          <span>Page {e.page}</span>
        </span>
        <q>{e.quote}</q>
        <span className="src-pop-foot">{st.tip}. Click to open it highlighted in the PDF.</span>
      </span>
    </span>
  );
}

export function EvidenceList({ evidence }: { evidence: VerifiedEvidence[] }) {
  if (!evidence.length) return null;
  return (
    <span className="ev">
      {evidence.map((e, i) => (
        <Source key={i} e={e} />
      ))}
    </span>
  );
}
