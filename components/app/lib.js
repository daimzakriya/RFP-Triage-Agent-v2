import { twMerge } from "tailwind-merge";
import { moneyIn } from "@/lib/view";

export const cn = (...a) => twMerge(a.filter(Boolean).join(" "));

/* ---------- dates (local calendar days) ---------- */
export const today = () => { const t = new Date(); t.setHours(0, 0, 0, 0); return t; };
export const toDate = (iso) => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d); };
export const daysTo = (iso) => Math.round((toDate(iso) - today()) / 86400000);
export const fmtDate = (iso, opts = { month: "short", day: "numeric", year: "numeric" }) => (iso ? toDate(iso).toLocaleDateString("en-US", opts) : "Not stated");
export const fmtShort = (iso) => fmtDate(iso, { month: "short", day: "numeric" });
export const relText = (iso) => { if (!iso) return ""; const n = daysTo(iso); return n < 0 ? `${-n}d ago` : n === 0 ? "Today" : n === 1 ? "Tomorrow" : `in ${n}d`; };
export const urgency = (iso) => { if (!iso) return "none"; const n = daysTo(iso); return n < 0 ? "past" : n <= 7 ? "urgent" : n <= 21 ? "soon" : "later"; };

/* ---------- categories (same inks as the PDF highlights) ---------- */
export const CATS = {
  date: { label: "Deadlines & dates", short: "Dates", color: "var(--c-date)" },
  mandatory: { label: "Mandatory requirements & disqualifiers", short: "Mandatory", color: "var(--c-mandatory)" },
  evaluation: { label: "Evaluation & scoring", short: "Scoring", color: "var(--c-evaluation)" },
  eligibility: { label: "Eligibility & compliance", short: "Eligibility", color: "var(--c-eligibility)" },
  contract: { label: "Contract obligations", short: "Contract", color: "var(--c-contract)" },
  risk: { label: "Risks, warnings & ambiguities", short: "Risks", color: "var(--c-risk)" },
  other: { label: "Other key information", short: "Other", color: "var(--c-other)" },
};
export const STATUS = {
  meets: { label: "Meets", tone: "bid" },
  verify: { label: "Verify", tone: "warn" },
  fails: { label: "Can't meet", tone: "nobid" },
};
export const TABS = [
  { id: "overview", label: "Overview" },
  { id: "requirements", label: "Requirements" },
  { id: "dates", label: "Key dates" },
  { id: "fit", label: "Fit score" },
  { id: "scoring", label: "Scoring & submission" },
  { id: "contract", label: "Contract terms" },
  { id: "risks", label: "Deal-breakers" },
];
export const STAGES = [
  { id: "reading", label: "Reading every page of the PDF" },
  { id: "analysing", label: "Extracting facts, dates and requirements" },
  { id: "checking", label: "Checking quotes against the document and scoring fit" },
];
export const shortId = (r) => r.solicitation.replace(/^RFP\s*(No\.?|Number)?\s*/i, "") || r.fileName.replace(/\.pdf$/i, "");

/* ---------- evidence index: one ordered list of findings per report ---------- */
const cache = new WeakMap();
export function findings(r) {
  if (cache.has(r)) return cache.get(r);
  const list = [];
  const add = (tab, label, cat, evs, extra = "") =>
    (evs || []).forEach((ev) => { const i = list.length; ev._i = i; list.push({ i, tab, label, cat, ev, extra }); });
  r.facts.forEach((f) => add("overview", f.label, f.cat, f.ev, f.value));
  r.requirements.forEach((q) => add("requirements", `${q.id}: ${q.text}`, q.cat, q.ev, `${q.group} ${q.reason}`));
  r.dates.forEach((d) => add("dates", d.label, d.ambiguous ? "risk" : "date", d.ev, d.note || ""));
  r.addenda.forEach((a) => add("dates", a.label, "date", a.ev, a.summary));
  r.criteria.forEach((c) => add("scoring", c.name, "evaluation", c.ev, c.note || ""));
  if (r.award) add("scoring", "Award basis", "evaluation", r.award.ev, r.award.text);
  r.submission.forEach((s) => add("scoring", `Submit: ${s.name}`, "other", s.ev, s.note || ""));
  r.terms.forEach((t) => add("contract", t.topic, "contract", t.ev, t.text));
  r.dealBreakers.forEach((b) => add("risks", b.text, b.severity === "blocking" ? "mandatory" : "risk", b.ev));
  r.ambiguities.forEach((a) => add("risks", a.text, "risk", a.ev));
  cache.set(r, list);
  return list;
}
export const pageFindings = (r, page) => findings(r).filter((f) => f.ev.page === page && f.ev.boxes?.length);
export const findingText = (f) => `${f.label} ${f.ev.quote} ${f.extra}`.toLowerCase();

/* ---------- derived figures ---------- */
export function derive(r) {
  const due = r.dates.find((d) => d.kind === "proposal" && d.date) || r.dates.find((d) => d.kind === "proposal");
  const upcoming = r.dates.filter((d) => d.date && daysTo(d.date) >= 0).sort((a, b) => toDate(a.date) - toDate(b.date));
  const nextMandatory = upcoming.find((d) => d.mandatory && d.kind !== "proposal");
  const valueFact = r.facts.find((f) => f.key === "contract_value");
  const value = valueFact && !valueFact.notStated ? moneyIn(valueFact.value) : null;
  const musts = r.requirements.filter((q) => q.must);
  const count = (s) => r.requirements.filter((q) => q.status === s).length;
  const blocking = r.dealBreakers.filter((b) => b.severity === "blocking").length;
  const verify = count("verify");
  const blocker = r.dealBreakers.find((b) => b.severity === "blocking");
  const dueText = due?.date ? ` before proposals are due ${fmtShort(due.date)}` : "";
  const headline = r.degraded
    ? "No call yet. The full analysis couldn't finish, so this is a quick text-search report without a fit score."
    : r.decision === "BID"
      ? verify
        ? `Worth bidding. ${verify} requirement${verify === 1 ? "" : "s"} to confirm${dueText}.`
        : `Worth bidding. Nothing left to confirm${dueText}.`
      : `${r.fastNoBid ? "Ruled out early. " : ""}${blocker ? blocker.text : r.reasons[0] || "Not a fit for idiaz.io."}`;
  const nextAction = r.degraded
    ? { title: "Retry the full analysis" }
    : r.decision === "BID"
    ? upcoming[0] ? { title: upcoming[0].label, date: upcoming[0].date } : { title: "Prepare the proposal" }
    : { title: "Archive. No bid." };
  return { due, upcoming, nextMandatory, value, musts, meets: count("meets"), verify, fails: count("fails"), blocking, headline, nextAction };
}
