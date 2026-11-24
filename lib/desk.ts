/**
 * Bid Desk (bonus feature): rank several triaged RFPs so the bids lead knows
 * which one to work on first, and what is due next.
 */
import { daysUntil } from "./dates";
import type { Located } from "./evidence-map";
import type { TriageReport } from "./schema";

export interface DeskItem {
  id: string;
  addedAt: string;
  report: TriageReport;
  pages?: string[]; // kept for the source viewer when storage allows
  /** Key of the original PDF in the browser's PDF store (IndexedDB); kept across retries. */
  docId?: string;
  /** Where each quoted finding sits in the PDF (computed once after analysis). Keyed by "page|quote". */
  locations?: Record<string, Located>;
}

export interface NextAction {
  label: string;
  date: string;
  days: number;
  mandatory: boolean;
}

/** The next upcoming dated deadline (today or later). */
export function nextAction(r: TriageReport, today = new Date()): NextAction | null {
  const upcoming = r.deadlines
    .filter((d) => d.date && daysUntil(d.date, today) >= 0)
    .map((d) => ({ label: d.label, date: d.date!, days: daysUntil(d.date!, today), mandatory: d.mandatory }))
    .sort((a, b) => a.days - b.days);
  return upcoming[0] ?? null;
}

export function proposalDue(r: TriageReport, today = new Date()) {
  const d = r.deadlines.find((x) => x.kind === "proposal_due" && x.date);
  return d?.date ? { date: d.date, days: daysUntil(d.date, today) } : null;
}

/**
 * Priority: BIDs before NO_BIDs; within BIDs, higher fit first, then the
 * nearest proposal deadline. Expired proposals sink to the bottom.
 */
export function rankDesk(items: DeskItem[], today = new Date()): DeskItem[] {
  const key = (it: DeskItem) => {
    const due = proposalDue(it.report, today);
    const expired = due ? due.days < 0 : false;
    return {
      group: expired ? 3 : it.report.decision === "BID" ? 0 : it.report.decision === "UNDETERMINED" ? 1 : 2,
      fit: -it.report.fit_score,
      due: due ? due.days : 9999,
    };
  };
  return [...items].sort((a, b) => {
    const ka = key(a), kb = key(b);
    return ka.group - kb.group || ka.fit - kb.fit || ka.due - kb.due;
  });
}

const STORAGE_KEY = "rfp-triage-desk-v1";

export function loadDesk(): DeskItem[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as DeskItem[]) : [];
    return Array.isArray(parsed) ? parsed.filter((x) => x?.report?.schemaVersion === "1.0") : [];
  } catch {
    return [];
  }
}

export function saveDesk(items: DeskItem[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // Quota exceeded: keep the reports, drop the page text (the source viewer is then unavailable for old items).
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items.map(({ pages: _p, ...rest }) => rest)));
    } catch {
      /* storage unavailable (private mode); the desk still works for this session */
    }
  }
}
