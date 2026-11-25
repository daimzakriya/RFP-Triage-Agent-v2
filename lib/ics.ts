/**
 * iCalendar (.ics) export of RFP deadlines (RFC 5545).
 * Events are all-day so a "3:00 PM Pacific" deadline never shifts to the wrong
 * day in another time zone; the exact time and zone go in the title.
 */
import type { TriageReport } from "./schema";

function esc(s: string) {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Fold lines longer than 75 octets, as the spec requires. */
function fold(line: string) {
  const out: string[] = [];
  let rest = line;
  while (rest.length > 74) {
    out.push(rest.slice(0, 74));
    rest = " " + rest.slice(74);
  }
  out.push(rest);
  return out.join("\r\n");
}

function nextDay(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return t.toISOString().slice(0, 10).replace(/-/g, "");
}

export function reportsToIcs(reports: TriageReport[], now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//WynBid//RFP Triage Agent//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];

  for (const r of reports) {
    for (const d of r.deadlines) {
      if (!d.date) continue;
      const when = [d.time, d.timezone].filter(Boolean).join(" ");
      const title = `${d.mandatory ? "[MANDATORY] " : ""}${d.label}${when ? ` (${when})` : ""}: ${r.solicitation_number || r.title}`;
      const desc = [
        `${r.title}`,
        `Decision: ${r.decision}, fit ${r.fit_score}/10`,
        d.note ?? "",
        ...d.evidence.map((e) => `Source p.${e.page}: "${e.quote}"`),
      ].filter(Boolean).join("\n");
      const uid = `${(r.solicitation_number || r.title).replace(/[^A-Za-z0-9]+/g, "-")}-${d.kind}-${d.date}@wynbid`;
      lines.push(
        "BEGIN:VEVENT",
        `UID:${uid}`,
        `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${d.date.replace(/-/g, "")}`,
        `DTEND;VALUE=DATE:${nextDay(d.date)}`,
        `SUMMARY:${esc(title)}`,
        `DESCRIPTION:${esc(desc)}`,
        "TRANSP:TRANSPARENT",
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        `DESCRIPTION:${esc(title)}`,
        `TRIGGER:-P${d.kind === "proposal_due" ? 3 : 1}D`,
        "END:VALARM",
        "END:VEVENT",
      );
    }
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
