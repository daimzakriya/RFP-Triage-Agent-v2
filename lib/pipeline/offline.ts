/**
 * Degraded mode: a report built by text search alone, used when every AI
 * provider is unavailable (free-tier quota or overload). It never guesses a
 * recommendation: decision = "UNDETERMINED", no fit score. Everything it
 * shows is a verbatim line from the PDF with its page number.
 */
import { findDates } from "../dates";
import type { Deadline, Requirement, ReviewFlag, TriageReport } from "../schema";
import { checkRequirementCoverage, detectAddenda, DocumentIndex, fillMissingDeadlines, verifyDeadline, verifyItem } from "../verify";
import { findChangeStatements } from "./preprocess";

const KIND_RULES: [Deadline["kind"], RegExp, string][] = [
  ["site_visit", /site (visit|walk)|walk-?through|pre-?bid meeting/i, "Site visit / walk-through"],
  ["pre_proposal_conference", /pre-?proposal conference|pre-?bid conference/i, "Pre-proposal conference"],
  ["questions_due", /question|inquir|clarification/i, "Questions due"],
  ["proposal_due", /(proposals?|bids?|responses?|submissions?|offers?)\b.{0,30}\b(due|deadline|received|submitted)|due date|closing date/i, "Proposal due"],
  ["award", /award|intent to award/i, "Award"],
  ["work_start", /notice to proceed|contract start|start date|commence|period of performance begins/i, "Work start"],
];

const REQ_RULES: [Requirement["category"], RegExp][] = [
  ["set_aside", /\b(set[- ]aside|small business|8\(a\)|hubzone|sdvosb|wosb|mbe|wbe|dbe|mbe\/wbe|local (business )?preference)\b/i],
  ["insurance_bonding", /\b(insurance|liability|bonds?|surety|guarant(y|ee))\b/i],
  ["past_performance", /\b(years? (of )?(experience|in business|continuous)|references?|past performance|projects? in the past)\b/i],
  ["registration", /\b(registered|registration|licen[cs]ed?|ubi|sam\.gov)\b/i],
  ["security_clearance", /clearance|background check|fingerprint/i],
  ["certification", /soc 2|iso 27001|fedramp|cmmi|certif/i],
  ["accessibility", /wcag|ada\b|accessib|language access|spanish/i],
  ["security_privacy", /encrypt|single sign|sso|mfa|multi-factor|hosting|data (center|residency)|breach|retention/i],
  ["staffing", /\b(project manager|key personnel|staff|staffing|supervisor|on-?site|in person|wages?)\b/i],
  ["technical", /integrat|availability|uptime|api\b|interface|system/i],
];

function lines(page: string) {
  return page.split("\n").map((l) => l.trim()).filter((l) => l.length > 12);
}

function shortQuote(s: string, max = 28) {
  const w = s.split(/\s+/);
  return w.length > max ? w.slice(0, max).join(" ") : s;
}

export function buildOfflineReport(pages: string[], fileName: string, reason: string): TriageReport {
  const idx = new DocumentIndex(pages);
  const flags: ReviewFlag[] = [];
  const changes = findChangeStatements(pages);

  /* identity */
  const head = pages[0] ?? "";
  const sol = /\b(?:RFP|RFQ|RFI|IFB|ITB|Bid|Solicitation|Tender)\s*(?:No\.?|Number|#)\s*[:\-]?\s*([A-Z0-9][A-Z0-9\-/.]{3,})/i.exec(head);
  const headLines = lines(head);
  const solIdx = headLines.findIndex((l) => /\b(RFP|RFQ|IFB|ITB|Bid|Solicitation|Tender)\s*(No\.?|Number|#)/i.test(l));
  const titleLines: string[] = [];
  for (const l of headLines.slice(solIdx + 1, solIdx + 4)) {
    if (findDates(l).length || /\b(issue date|due|contact|set-?aside)\b/i.test(l)) break;
    titleLines.push(l);
  }
  const title = (solIdx >= 0 && titleLines.join(" ")) || fileName.replace(/\.pdf$/i, "");

  /* deadlines: lines that contain a date and a recognisable event keyword */
  const found: Deadline[] = [];
  pages.forEach((p, i) => {
    for (const l of lines(p)) {
      const dates = findDates(l);
      if (!dates.length) continue;
      for (const [kind, re, label] of KIND_RULES) {
        if (!re.test(l) || found.some((d) => d.kind === kind)) continue;
        // the last date on the line is usually the current one (e.g. "Jan 8, 2027 Jan 15, 2027")
        const change = changes.find((c) => dates.includes(c.from));
        const date = change ? change.to : dates[dates.length - 1];
        found.push({
          kind,
          label,
          date,
          time: /(\d{1,2}:\d{2}\s*[AP]\.?M\.?)/i.exec(l)?.[1] ?? null,
          timezone: /\b(Pacific|Eastern|Central|Mountain|PT|ET|CT|MT|PST|EST|CST|MST|UTC)\b/.exec(l)?.[1] ?? null,
          mandatory: /mandatory|required to attend|will be rejected/i.test(l + " " + (lines(p)[lines(p).indexOf(l) + 1] ?? "")),
          status: dates.length > 1 ? "ambiguous" : "stated",
          note: change
            ? `Revised from ${change.from} by ${change.addendum ?? "a change statement"} (p.${change.page}).`
            : dates.length > 1
              ? "Line shows more than one date; check which one applies."
              : "Found by text search; not reviewed by AI.",
          evidence: [{ page: i + 1, quote: shortQuote(l) }],
        });
        break;
      }
    }
  });
  const deadlines = fillMissingDeadlines(found)
    .map((d) => {
      const v = verifyDeadline(idx, d, flags);
      const change = changes.find((c) => c.to === d.date);
      return { what: d.label, ...v, original_date: change?.from ?? null, revised_by: change?.addendum ?? null };
    })
    .sort((a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999"));

  /* requirements: must/shall sentences, categorised by keywords */
  const reqs: Requirement[] = [];
  const seen = new Set<string>();
  pages.forEach((p, i) => {
    const text = p.replace(/\s*\n\s*/g, " ");
    for (const sent of text.split(/(?<=[.;])\s+(?=[A-Z(])/)) {
      if (!/\b(must|shall|required|mandatory|minimum)\b/i.test(sent) || sent.length < 30 || sent.length > 320) continue;
      const toks = sent.split(/\s+/);
      if (toks.filter((t) => /\d/.test(t)).length / toks.length > 0.3) continue; // table rows, not sentences
      const cat = REQ_RULES.find(([, re]) => re.test(sent))?.[0];
      if (!cat) continue;
      const key = sent.toLowerCase().slice(0, 80);
      if (seen.has(key)) continue;
      seen.add(key);
      reqs.push({ category: cat, text: sent.trim(), mandatory: !/\b(desired|preferred|optional)\b/i.test(sent), evidence: [{ page: i + 1, quote: shortQuote(sent.trim()) }] });
      if (reqs.length >= 60) return;
    }
  });
  const requirements = reqs.map((r, i) => ({ ...verifyItem(idx, r, `requirements[${i}]`, flags), id: `R${i + 1}` }));

  flags.push(...checkRequirementCoverage(idx, requirements));
  const add = detectAddenda(idx);
  if (add) flags.unshift(add);
  flags.unshift({
    level: "warning",
    field: "document",
    message: "AI analysis unavailable right now (free model quota or overload). This report was built by text search only: no fit score, no recommendation, and requirements are raw sentences. Use “Retry full analysis”.",
  });

  const notStated = (v = "Not stated") => ({ value: v, status: "not_stated" as const, note: null, evidence: [], needsReview: false });
  const evAll = [...deadlines.flatMap((d) => d.evidence), ...requirements.flatMap((r) => r.evidence)];
  const nonSoftware = /\b(janitorial|custodial|construction|paving|roofing|landscap|mowing|snow removal|food service|uniforms|fuel|hvac installation)\b/i;
  const software = /\b(software|platform|application|portal|api|cloud|saas|automation|ai\b|machine learning|web|mobile)\b/i;
  const all = pages.join(" ");
  const nonSwHits = (all.match(new RegExp(nonSoftware.source, "gi")) ?? []).length;
  const swHits = (all.match(new RegExp(software.source, "gi")) ?? []).length;

  return {
    schemaVersion: "1.0",
    pipeline: "v2",
    degraded: true,
    degradedReason: reason,
    generatedAt: new Date().toISOString(),
    document: { fileName, pageCount: pages.length, characters: pages.reduce((n, p) => n + p.length, 0), truncated: false },
    model: { provider: "Text search only (AI unavailable)", name: "none", latencyMs: 0 },
    decision: "UNDETERMINED",
    fastNoBid: false,
    modelRecommendation: "UNDETERMINED",
    decisionNote:
      nonSwHits > 5 && nonSwHits > swHits
        ? `Keyword screen: the text mentions non-software services ${nonSwHits} times vs software terms ${swHits} times, which suggests work outside idiaz.io's services. Not an AI assessment.`
        : "No recommendation without the AI assessment.",
    fit_score: 0,
    fit_factors: [],
    title,
    solicitation_number: sol?.[1] ?? "Not stated",
    summary: "AI summary unavailable. Dates, addenda and requirement sentences below were found by text search and link to their pages.",
    facts: {
      agency: notStated(),
      scope: notStated(),
      contract_type: notStated(),
      contract_value: notStated(),
      work_location: notStated(),
      period_of_performance: notStated(),
      submission_method: notStated(),
    },
    deadlines,
    requirements,
    reasons: [],
    change_mind: [],
    deal_breakers: [],
    open_questions: [],
    ambiguities: [],
    review_flags: flags,
    evidence_stats: {
      total: evAll.length,
      verified: evAll.filter((e) => e.check === "verified" || e.check === "relocated").length,
      approximate: evAll.filter((e) => e.check === "approximate").length,
      unverified: evAll.filter((e) => e.check === "unverified").length,
    },
    addenda: changes.map((c) => ({
      label: c.addendum ?? "Schedule change",
      issued_date: null,
      summary: c.quote,
      changes: [{ what: "Date", from: c.from, to: c.to }],
      acknowledgement_required: false,
      evidence: [{ page: c.page, quote: shortQuote(c.quote), check: "verified" as const }],
      confirmed: true,
    })),
    quality: {
      status: "incomplete",
      checks: [{ id: "ai", label: "AI analysis completed", status: "fail", detail: reason.slice(0, 300) }],
    },
  };
}
