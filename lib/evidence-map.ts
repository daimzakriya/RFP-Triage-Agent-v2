/**
 * Evidence highlighting in the original PDF.
 *
 * 1. While the PDF is read (once, in the browser), every text run on every page is kept
 *    with its position on the page (fractions of page width/height, so it stays correct at
 *    any zoom level).
 * 2. After the analysis, every quote in the report is located once in those text runs:
 *    exact match first (after normalising case, whitespace, line breaks, hyphenation,
 *    quote marks and ligatures), then a strict word-window fuzzy match as a fallback.
 *    Short or repeated quotes that can't be pinned to one place are NOT highlighted.
 * 3. The result (page, quote, category, boxes, confidence) is cached with the report.
 */
import type { TriageReport, VerifiedEvidence } from "./schema";

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

/** One text run on a page. x, y (top), w, h are fractions of the page size (0 to 1). */
export interface TextRun {
  s: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Matrix = [number, number, number, number, number, number];
function mul(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

/** Minimal shape of the pdf.js objects we use (keeps this file free of a pdf.js import). */
interface PdfTextItem {
  str?: string;
  transform?: number[];
  width?: number;
  height?: number;
}
interface PdfPageLike {
  getViewport(p: { scale: number }): { width: number; height: number; transform: number[] };
  getTextContent(): Promise<{ items: unknown[] }>;
}

/** Text runs of one pdf.js page, positioned in page fractions (top-left origin). */
export async function pageRuns(page: PdfPageLike): Promise<TextRun[]> {
  const vp = page.getViewport({ scale: 1 });
  const { items } = await page.getTextContent();
  const runs: TextRun[] = [];
  for (const raw of items as PdfTextItem[]) {
    if (!raw.str || !raw.transform || !raw.str.trim()) continue;
    const t = mul(vp.transform as Matrix, raw.transform as Matrix);
    const fontH = Math.hypot(t[2], t[3]) || raw.height || 10;
    const width = (raw.width ?? 0) * Math.hypot(vp.transform[0], vp.transform[1]);
    runs.push({
      s: raw.str,
      x: t[4] / vp.width,
      y: (t[5] - fontH * 0.9) / vp.height,
      w: width / vp.width,
      h: (fontH * 1.15) / vp.height,
    });
  }
  return runs;
}

/* ------------------------------------------------------------------ */
/* Matching                                                            */
/* ------------------------------------------------------------------ */

export type MatchConfidence = "exact" | "fuzzy" | "none";

export interface Located {
  page: number;
  quote: string;
  boxes: Box[];
  confidence: MatchConfidence;
  score: number; // 1 for exact, word-overlap share for fuzzy, 0 for none
  reason?: string; // why it isn't highlighted (confidence "none")
}

/** Characters that count for matching: lowercase letters and digits only. Handles ligatures and accents. */
function normChar(c: string): string {
  return c
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

interface CharMap {
  text: string; // compact normalised page text
  run: number[]; // run index of each compact char
  pos: number[]; // char index inside that run's string
}

function compactPage(runs: TextRun[]): CharMap {
  const map: CharMap = { text: "", run: [], pos: [] };
  let text = "";
  runs.forEach((r, ri) => {
    for (let j = 0; j < r.s.length; j++) {
      const n = normChar(r.s[j]);
      for (const ch of n) {
        text += ch;
        map.run.push(ri);
        map.pos.push(j);
      }
    }
  });
  map.text = text;
  return map;
}

function compact(s: string): string {
  return [...s].map(normChar).join("");
}

function allIndexes(hay: string, needle: string, from = 0): number[] {
  const out: number[] = [];
  let i = hay.indexOf(needle, from);
  while (i >= 0) {
    out.push(i);
    i = hay.indexOf(needle, i + 1);
  }
  return out;
}

/** Boxes covering compact chars [start, end): one box per run piece, merged per line. */
function boxesFor(runs: TextRun[], map: CharMap, start: number, end: number): Box[] {
  const pieces = new Map<number, { a: number; b: number }>();
  for (let k = start; k < end; k++) {
    const ri = map.run[k];
    const p = map.pos[k];
    const cur = pieces.get(ri);
    if (!cur) pieces.set(ri, { a: p, b: p });
    else {
      cur.a = Math.min(cur.a, p);
      cur.b = Math.max(cur.b, p);
    }
  }
  const raw: Box[] = [];
  for (const [ri, { a, b }] of [...pieces.entries()].sort((x, y) => x[0] - y[0])) {
    const r = runs[ri];
    // pdf.js gives the width of the whole run; split it by typical glyph widths, not by
    // character count, so a highlight that starts mid-run lands on the right letter.
    const cum = [0];
    for (const ch of r.s) cum.push(cum[cum.length - 1] + glyphWidth(ch));
    const total = cum[cum.length - 1] || 1;
    raw.push({ x: r.x + (r.w * cum[a]) / total, y: r.y, w: (r.w * (cum[b + 1] - cum[a])) / total, h: r.h });
  }
  // merge pieces that sit on the same line
  const merged: Box[] = [];
  for (const bx of raw) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(last.y - bx.y) < last.h * 0.5 && bx.x >= last.x - 0.01 && bx.x - (last.x + last.w) < 0.03) {
      const right = Math.max(last.x + last.w, bx.x + bx.w);
      last.y = Math.min(last.y, bx.y);
      last.h = Math.max(last.h, bx.h);
      last.w = right - last.x;
    } else merged.push({ ...bx });
  }
  const r4 = (n: number) => Math.round(n * 10000) / 10000; // compact for storage
  return merged.map((b) => ({ x: r4(Math.max(0, b.x - 0.002)), y: r4(Math.max(0, b.y)), w: r4(Math.min(1, b.w + 0.004)), h: r4(b.h) }));
}

/** Relative advance widths of a typical proportional font (Helvetica/Arial-like, em = 1). */
function glyphWidth(c: string): number {
  if (c === " ") return 0.28;
  if ("il.,:;'|!".includes(c)) return 0.24;
  if ("jtfrI()[]-/".includes(c)) return 0.33;
  if ("mwMW@".includes(c)) return 0.86;
  if (/[A-Z]/.test(c)) return 0.68;
  if (/[0-9$]/.test(c)) return 0.56;
  if (/[a-z]/.test(c)) return 0.52;
  return 0.56;
}

const MIN_EXACT = 12; // shorter quotes ("$420,000") must be unique on the page to be highlighted
const FUZZY_MIN_WORDS = 6;
const FUZZY_MIN_SHARE = 0.85;

export function locateQuote(runs: TextRun[] | undefined, page: number, quote: string): Located {
  const none = (reason: string): Located => ({ page, quote, boxes: [], confidence: "none", score: 0, reason });
  if (!runs || runs.length === 0) return none("No text positions are available for this page.");
  const map = compactPage(runs);

  /* 1. exact: every "..."-separated segment, in order */
  const parts = quote.split(/\.\.\.|…/).map(compact).filter(Boolean);
  // with several "..." pieces, ignore tiny fragments; a single short quote is kept (it must then be unique)
  const segments = parts.length > 1 ? parts.filter((p) => p.length >= 4) : parts.filter((p) => p.length >= 2);
  const total = segments.reduce((n, s) => n + s.length, 0);
  if (segments.length) {
    let from = 0;
    const ranges: [number, number][] = [];
    let ok = true;
    for (const seg of segments) {
      const hits = allIndexes(map.text, seg, from);
      if (!hits.length) {
        ok = false;
        break;
      }
      // a short quote that occurs more than once can't be pinned to one place
      if (total < MIN_EXACT && hits.length > 1) {
        return none(`This short quote appears ${hits.length} times on the page, so it isn't pinned to one place.`);
      }
      ranges.push([hits[0], hits[0] + seg.length]);
      from = hits[0] + seg.length;
    }
    if (ok) {
      return { page, quote, confidence: "exact", score: 1, boxes: ranges.flatMap(([a, b]) => boxesFor(runs, map, a, b)) };
    }
  }

  /* 2. fuzzy fallback: best window of page words covering >= 85% of the quote's words */
  const qWords = quote
    .split(/[^\p{L}\p{N}]+/u)
    .map(compact)
    .filter(Boolean);
  if (qWords.length < FUZZY_MIN_WORDS) return none("The quote wasn't found word for word, and it's too short for a safe close match.");

  // page words with their compact-char spans
  const words: { w: string; a: number; b: number }[] = [];
  {
    let i = 0;
    runs.forEach((r) => {
      for (const part of r.s.split(/[^\p{L}\p{N}]+/u)) {
        const c = compact(part);
        if (!c) continue;
        const at = map.text.indexOf(c, i);
        if (at < 0) continue;
        words.push({ w: c, a: at, b: at + c.length });
        i = at + c.length;
      }
    });
  }
  const need = new Map<string, number>();
  qWords.forEach((w) => need.set(w, (need.get(w) ?? 0) + 1));
  let best = { share: 0, start: -1, end: -1 };
  const L = qWords.length;
  for (const len of [L, Math.round(L * 1.15)]) {
    for (let s = 0; s + len <= words.length; s++) {
      if (!need.has(words[s].w)) continue; // windows start on a quote word
      const have = new Map<string, number>();
      let hit = 0;
      for (let k = s; k < s + len; k++) {
        const w = words[k].w;
        const n = have.get(w) ?? 0;
        if (n < (need.get(w) ?? 0)) hit++;
        have.set(w, n + 1);
      }
      const share = hit / L;
      if (share > best.share) best = { share, start: s, end: s + len - 1 };
    }
  }
  if (best.share >= FUZZY_MIN_SHARE) {
    // trim the window to the first and last quote word
    let s = best.start;
    let e = best.end;
    while (s < e && !need.has(words[s].w)) s++;
    while (e > s && !need.has(words[e].w)) e--;
    return {
      page,
      quote,
      confidence: "fuzzy",
      score: Math.round(best.share * 100) / 100,
      boxes: boxesFor(runs, map, words[s].a, words[e].b),
    };
  }
  return none(
    best.share > 0
      ? `The closest passage on this page shares only ${Math.round(best.share * 100)}% of the quote's words, so it isn't highlighted.`
      : "The quote wasn't found on this page.",
  );
}

/* ------------------------------------------------------------------ */
/* Findings and categories                                             */
/* ------------------------------------------------------------------ */

export type HighlightCategory = "date" | "mandatory" | "evaluation" | "eligibility" | "contract" | "risk" | "other";

export const CATEGORY_INFO: Record<HighlightCategory, { label: string; color: string }> = {
  date: { label: "Deadlines & dates", color: "#f5c518" },
  mandatory: { label: "Mandatory requirements & disqualifiers", color: "#e5484d" },
  evaluation: { label: "Evaluation & scoring", color: "#3b82f6" },
  eligibility: { label: "Eligibility & compliance", color: "#22a06b" },
  contract: { label: "Contract obligations", color: "#8b5cf6" },
  risk: { label: "Risks, warnings & ambiguities", color: "#f97316" },
  other: { label: "Other key information", color: "#8a8f98" },
};

export interface Finding {
  key: string; // page|quote
  label: string; // what the finding is, for the viewer header
  category: HighlightCategory;
  evidence: VerifiedEvidence;
}

export const evidenceKey = (e: { page: number; quote: string }) => `${e.page}|${e.quote}`;

const ELIGIBILITY = new Set(["set_aside", "past_performance", "registration", "certification", "insurance_bonding", "security_clearance"]);

/** Every quoted finding in a report with its highlight category. First listing wins for duplicates. */
export function collectFindings(r: TriageReport): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<string>();
  const add = (label: string, category: HighlightCategory, evs: VerifiedEvidence[] | undefined) => {
    for (const e of evs ?? []) {
      const key = evidenceKey(e);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, label, category, evidence: e });
    }
  };
  for (const d of r.deal_breakers ?? []) add(d.text, d.severity === "blocking" ? "mandatory" : "risk", d.evidence);
  for (const d of r.deadlines ?? []) add(d.label, d.status === "ambiguous" ? "risk" : "date", d.evidence);
  for (const a of r.addenda ?? []) add(a.label, "date", a.evidence);
  for (const q of r.requirements ?? []) {
    const cat: HighlightCategory = ELIGIBILITY.has(q.category)
      ? "eligibility"
      : q.category === "contract_terms"
        ? "contract"
        : q.mandatory
          ? "mandatory"
          : "evaluation";
    add(`${q.id ? q.id + " · " : ""}${q.text}`, cat, q.evidence);
  }
  for (const c of r.evaluation_criteria ?? []) add(`Evaluation: ${c.name}`, "evaluation", c.evidence);
  if (r.award_basis) add("Award basis", "evaluation", r.award_basis.evidence);
  for (const t of r.contract_terms ?? []) add(t.topic, "contract", t.evidence);
  for (const [k, f] of Object.entries(r.facts ?? {})) {
    const cat: HighlightCategory =
      f.status === "ambiguous" ? "risk" : ["contract_value", "contract_type", "period_of_performance"].includes(k) ? "contract" : "other";
    add(k.replace(/_/g, " "), cat, f.evidence);
  }
  for (const s of r.submission_items ?? []) add(`Submit: ${s.name}`, "other", s.evidence);
  return out;
}

/** Locate every finding once. Returns a map keyed by evidenceKey. */
export function locateAll(r: TriageReport, runsByPage: (TextRun[] | undefined)[]): Record<string, Located> {
  const out: Record<string, Located> = {};
  for (const f of collectFindings(r)) {
    const p = f.evidence.page;
    out[f.key] = locateQuote(runsByPage[p - 1], p, f.evidence.quote);
  }
  return out;
}
