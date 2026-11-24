/**
 * Deterministic pre-processing (no model calls):
 *  - token estimates and the decision whether each worker sees the whole document
 *  - section-aware page routing for long documents
 *  - an addendum scanner that finds explicit "changed from X to Y" statements
 */
import { findDates, normalize } from "../dates";

/** ~4 characters per token for English prose; used for routing decisions, not billing (billing uses usageMetadata). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export type WorkerId = "schedule" | "requirements" | "evaluation";

/** Page-relevance signals per worker. Generic procurement vocabulary only, nothing RFP-specific. */
const SIGNALS: Record<WorkerId, RegExp[]> = {
  schedule: [
    /\b(schedule|timeline|key dates|calendar|deadline|due|addend(um|a)|amendment|pre-?proposal|pre-?bid|site (visit|walk)|questions?|notice to proceed|award|contract start|term)\b/i,
    /\b(agency|department|issued by|solicitation|rfp no|bid no|contact|submit|submission|portal|sealed|deliver)\b/i,
  ],
  requirements: [
    /\b(shall|must|required|requirement|mandatory|minimum qualifications?|eligib|set[- ]aside|certif|licen[cs]e|registered|insurance|liability|bond|clearance|background|fingerprint|wage|experience|years|references?|key personnel|staff|on-?site|security|soc 2|fedramp|iso|encrypt|wcag|accessib|ada\b|hosting|availability|uptime|integrat|sla)\b/i,
  ],
  evaluation: [
    /\b(evaluat|criteria|criterion|points|weight|scor|award|best value|lowest|responsive|preference|demonstration|interview|oral)\b/i,
    /\b(attachment|appendix|exhibit|form \d|forms?|submittal|proposal contents|proposal format|page limit|copies|price|cost proposal|payment|invoice|terminat|liquidated|penalt|retainage|not-to-exceed|budget|warranty|indemn)\b/i,
  ],
};

export interface Routing {
  fullDocument: boolean;
  totalTokens: number;
  pagesByWorker: Record<WorkerId, number[]>; // 1-based page numbers
  uncoveredPages: number[]; // should always end up empty
}

/**
 * Small documents (the common case) go whole to every worker: best recall, and the
 * shared document prefix is served from Gemini's implicit cache after the first call.
 * Large documents are routed by section relevance; any page no worker claimed is
 * given to the requirements worker so every page is read at least once.
 */
export function routePages(pages: string[], fullDocTokenLimit = Number(process.env.FULL_DOC_TOKENS ?? 60_000)): Routing {
  const totalTokens = estimateTokens(pages.join("\n"));
  const all = pages.map((_, i) => i + 1);
  const ids: WorkerId[] = ["schedule", "requirements", "evaluation"];
  if (totalTokens <= fullDocTokenLimit) {
    return { fullDocument: true, totalTokens, pagesByWorker: { schedule: all, requirements: all, evaluation: all }, uncoveredPages: [] };
  }

  const pagesByWorker = { schedule: [] as number[], requirements: [] as number[], evaluation: [] as number[] };
  pages.forEach((text, i) => {
    for (const w of ids) {
      const hits = SIGNALS[w].reduce((n, re) => n + (text.match(new RegExp(re.source, "gi"))?.length ?? 0), 0);
      if (hits >= 2 || i < 2) pagesByWorker[w].push(i + 1); // cover page + TOC always go to everyone
    }
  });
  const claimed = new Set(ids.flatMap((w) => pagesByWorker[w]));
  const unclaimed = all.filter((p) => !claimed.has(p));
  pagesByWorker.requirements = [...new Set([...pagesByWorker.requirements, ...unclaimed])].sort((a, b) => a - b);
  const covered = new Set(ids.flatMap((w) => pagesByWorker[w]));
  return { fullDocument: false, totalTokens, pagesByWorker, uncoveredPages: all.filter((p) => !covered.has(p)) };
}

export function renderPages(pages: string[], pageNumbers: number[]): string {
  return pageNumbers.map((n) => `[[PAGE ${n}]]\n${pages[n - 1]}`).join("\n\n");
}

/* ------------------------------ addenda ------------------------------ */

export interface ChangeStatement {
  page: number;
  quote: string; // the sentence containing the change
  from: string; // ISO
  to: string; // ISO
  addendum: string | null; // e.g. "Addendum No. 1"
}

const ADDENDUM_LABEL = /\b(addendum|amendment)\s+(no\.?|number|#)?\s*(\d+|[ivx]+)\b/i;
const CHANGE_VERB = /\b(extended|changed|revised|moved|postponed|amended|rescheduled|replaced|updated)\b/i;

/**
 * Find explicit schedule changes: a sentence with a change verb and two dates
 * ("... extended from January 8, 2027 to January 15, 2027"). Only these count as
 * evidence that a date was superseded. A later date elsewhere in the PDF does not.
 */
export function findChangeStatements(pages: string[]): ChangeStatement[] {
  const out: ChangeStatement[] = [];
  const verbs = new RegExp(CHANGE_VERB.source, "gi");
  pages.forEach((raw, i) => {
    const text = raw.replace(/\s*\n\s*/g, " ");
    for (const v of text.matchAll(verbs)) {
      const at = v.index ?? 0;
      // "from <date> to <date>" must follow the verb closely
      const tail = text.slice(at, at + 160);
      const m = /\bfrom\b([\s\S]{4,60}?)\bto\b([\s\S]{4,60})/i.exec(tail);
      if (!m) continue;
      const [from] = findDates(m[1]);
      const [to] = findDates(m[2]);
      if (!from || !to || from === to) continue;
      // Quote: from the start of the clause (sentence start, or a label like "Addendum No. 1 (...):") to the end of the new date
      const before = text.slice(Math.max(0, at - 160), at);
      const clauseStart = Math.max(before.lastIndexOf(". "), before.lastIndexOf(": "), before.lastIndexOf("; "));
      const startIdx = Math.max(0, at - 160) + (clauseStart >= 0 ? clauseStart + 2 : 0);
      const toDateEnd = at + m.index + m[0].length - m[2].length + (m[2].search(/\d{4}/) + 4);
      const quote = text.slice(startIdx, Math.max(toDateEnd, at + 20)).trim();
      const label = [...text.slice(Math.max(0, at - 300), at).matchAll(new RegExp(ADDENDUM_LABEL.source, "gi"))].pop();
      out.push({ page: i + 1, quote, from, to, addendum: label ? `${cap(label[1])} No. ${label[3].toUpperCase()}` : null });
    }
  });
  return out;
}

function cap(s: string) {
  return s[0].toUpperCase() + s.slice(1).toLowerCase();
}

/** Does the document mention addenda at all (so the schedule worker must report on them)? */
export function mentionsAddenda(pages: string[]): boolean {
  return pages.some((p) => /\baddend(um|a)\b|\bamendment\s+(no\.?|#)?\s*\d/i.test(normalize(p)));
}
