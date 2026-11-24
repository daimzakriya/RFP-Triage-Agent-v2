/**
 * Minimal Google Gemini client (REST, no SDK) with structured JSON output.
 * Free tier: https://ai.google.dev/gemini-api/docs/rate-limits
 */

const S = "STRING", N = "NUMBER", I = "INTEGER", B = "BOOLEAN", O = "OBJECT", A = "ARRAY";

const evidence = {
  type: A,
  items: {
    type: O,
    properties: { page: { type: I }, quote: { type: S } },
    required: ["page", "quote"],
    propertyOrdering: ["page", "quote"],
  },
};
const status = { type: S, enum: ["stated", "not_stated", "ambiguous"] };
const fact = {
  type: O,
  properties: { value: { type: S }, status, note: { type: S, nullable: true }, evidence },
  required: ["value", "status", "evidence"],
  propertyOrdering: ["value", "status", "note", "evidence"],
};

/** OpenAPI-subset schema understood by Gemini's `responseSchema`. Mirrors ModelOutputSchema in schema.ts. */
export const GEMINI_RESPONSE_SCHEMA = {
  type: O,
  properties: {
    is_rfp: { type: B },
    title: { type: S },
    solicitation_number: { type: S },
    summary: { type: S },
    facts: {
      type: O,
      properties: {
        agency: fact,
        scope: fact,
        contract_type: fact,
        contract_value: fact,
        work_location: fact,
        period_of_performance: fact,
        submission_method: fact,
      },
      required: ["agency", "scope", "contract_type", "contract_value", "work_location", "period_of_performance", "submission_method"],
      propertyOrdering: ["agency", "scope", "contract_type", "contract_value", "work_location", "period_of_performance", "submission_method"],
    },
    deadlines: {
      type: A,
      items: {
        type: O,
        properties: {
          kind: { type: S, enum: ["questions_due", "proposal_due", "site_visit", "pre_proposal_conference", "work_start", "award", "other"] },
          label: { type: S },
          date: { type: S, nullable: true, description: "YYYY-MM-DD" },
          time: { type: S, nullable: true },
          timezone: { type: S, nullable: true },
          mandatory: { type: B },
          status,
          note: { type: S, nullable: true },
          evidence,
        },
        required: ["kind", "label", "date", "mandatory", "status", "evidence"],
        propertyOrdering: ["kind", "label", "date", "time", "timezone", "mandatory", "status", "note", "evidence"],
      },
    },
    requirements: {
      type: A,
      items: {
        type: O,
        properties: {
          category: {
            type: S,
            enum: ["skill", "certification", "set_aside", "security_clearance", "past_performance", "staffing", "registration", "insurance_bonding", "technical", "other"],
          },
          text: { type: S },
          mandatory: { type: B },
          evidence,
        },
        required: ["category", "text", "mandatory", "evidence"],
        propertyOrdering: ["category", "text", "mandatory", "evidence"],
      },
    },
    fit_factors: {
      type: A,
      items: {
        type: O,
        properties: {
          id: { type: S, enum: ["service_match", "team_fit", "eligibility", "commercial", "timeline"] },
          points: { type: N },
          reason: { type: S },
        },
        required: ["id", "points", "reason"],
        propertyOrdering: ["id", "points", "reason"],
      },
    },
    recommendation: { type: S, enum: ["BID", "NO_BID"] },
    reasons: { type: A, items: { type: S } },
    change_mind: { type: A, items: { type: S } },
    deal_breakers: {
      type: A,
      items: {
        type: O,
        properties: { text: { type: S }, severity: { type: S, enum: ["blocking", "verify"] }, evidence },
        required: ["text", "severity", "evidence"],
        propertyOrdering: ["text", "severity", "evidence"],
      },
    },
    open_questions: { type: A, items: { type: S } },
    ambiguities: {
      type: A,
      items: {
        type: O,
        properties: { text: { type: S }, evidence },
        required: ["text", "evidence"],
        propertyOrdering: ["text", "evidence"],
      },
    },
  },
  required: [
    "is_rfp", "title", "solicitation_number", "summary", "facts", "deadlines", "requirements",
    "fit_factors", "recommendation", "reasons", "change_mind", "deal_breakers", "open_questions", "ambiguities",
  ],
  propertyOrdering: [
    "is_rfp", "title", "solicitation_number", "summary", "facts", "deadlines", "requirements",
    "deal_breakers", "ambiguities", "fit_factors", "recommendation", "reasons", "change_mind", "open_questions",
  ],
};

export class LlmError extends Error {
  constructor(message: string, public status = 502) {
    super(message);
  }
}

export interface LlmUsage {
  input: number; // prompt tokens (including cached)
  output: number; // answer tokens
  thinking: number; // reasoning tokens (Gemini "thoughts")
  cached: number; // prompt tokens served from Gemini's implicit cache
}

export interface LlmResult {
  json: unknown;
  model: string;
  latencyMs: number;
  usage?: LlmUsage;
}

export interface GeminiCallOptions {
  quick?: boolean; // short busy-retries (a backup provider is available)
  schema?: object; // response schema; defaults to the full single-call report schema
  models?: string[]; // model order for this call; defaults to GEMINI_MODEL + GEMINI_FALLBACK_MODELS
  thinkingLevel?: "low" | "medium" | "high";
  /** Waits before retrying the SAME model when it is busy. [] = move to the next model at once. */
  busyWaits?: number[];
  /** Give up on one model after this long and try the next one. */
  attemptMs?: number;
}

/**
 * Per-instance memory of models that can't serve right now, so we stop spending
 * requests on them: daily quota used up (until the next reset, midnight Pacific)
 * or model not available to this key (for a day).
 */
const unavailableUntil = new Map<string, { until: number; why: string }>();
function nextPacificMidnight(now = Date.now()): number {
  // Midnight Pacific is 07:00 or 08:00 UTC; use 08:00 UTC (safe side).
  const d = new Date(now);
  const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 8);
  return t > now ? t : t + 86_400_000;
}
export function markUnavailable(model: string, why: string, until: number) {
  unavailableUntil.set(model, { until, why });
}
export function resetModelMemory() {
  unavailableUntil.clear();
  busyUntil.clear();
}

/**
 * Short memory of models that were just overloaded (503 or no answer in time). They are not
 * skipped, only tried last for the next ~90 s, so parallel and later calls go straight to a
 * model that is answering instead of each waiting on the same busy one.
 */
const busyUntil = new Map<string, number>();
const BUSY_MEMORY_MS = 90_000;
export function markBusy(model: string, now = Date.now()) {
  busyUntil.set(model, now + BUSY_MEMORY_MS);
}
export function orderByAvailability(models: string[], now = Date.now()): string[] {
  const free = models.filter((m) => !((busyUntil.get(m) ?? 0) > now));
  const busy = models.filter((m) => (busyUntil.get(m) ?? 0) > now);
  return [...free, ...busy];
}

export function defaultModels(): string[] {
  const primary = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
  const fallbacks = (process.env.GEMINI_FALLBACK_MODELS ?? "gemini-3.1-flash-lite,gemini-3.8-flash")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [primary, ...fallbacks.filter((m) => m !== primary)];
}

/**
 * Generation settings per model family.
 * - Gemini 3+: reasoning is set with thinkingLevel ("low" | "medium" | "high"); Google
 *   recommends leaving temperature at its default for these models.
 * - Gemini 2.5: thinkingBudget (tokens) and temperature 0.
 * `safe` drops the optional knobs; it's used to retry once if a model rejects a setting.
 */
export function generationConfig(model: string, safe = false, schema: object = GEMINI_RESPONSE_SCHEMA, thinkingLevel?: string) {
  const base: Record<string, unknown> = {
    responseMimeType: "application/json",
    responseSchema: schema,
  };
  if (safe) return base;
  const m = /gemini-(\d+)(?:\.(\d+))?/.exec(model);
  const major = m ? Number(m[1]) : 3;
  if (major >= 3) {
    return { ...base, maxOutputTokens: 32768, thinkingConfig: { thinkingLevel: thinkingLevel || process.env.GEMINI_THINKING_LEVEL || "low" } };
  }
  return {
    ...base,
    temperature: 0,
    maxOutputTokens: 16384,
    thinkingConfig: { thinkingBudget: Number(process.env.GEMINI_THINKING_BUDGET ?? 1024) },
  };
}

export async function callGemini(
  system: string,
  user: string,
  signal?: AbortSignal,
  opts: GeminiCallOptions = {},
): Promise<LlmResult> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new LlmError(
      "GEMINI_API_KEY is not set on the server. Add it to .env.local (local) or to the project's environment variables (Vercel).",
      500,
    );
  }

  const startedAll = Date.now();
  const attempts: string[] = []; // what each model said, for a useful final error
  let lastStatus = 502;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const BUDGET_MS = Number(process.env.GEMINI_RETRY_BUDGET_MS ?? 60_000); // total time we may spend waiting on busy models (function limit is 300 s)
  // An overloaded model can take minutes; cap each attempt so we can fall back in time.
  const ATTEMPT_MS = opts.attemptMs ?? Number(process.env.GEMINI_ATTEMPT_TIMEOUT_MS ?? 45_000);

  for (const model of orderByAvailability(opts.models?.length ? opts.models : defaultModels())) {
    const known = unavailableUntil.get(model);
    if (known && known.until > Date.now()) {
      attempts.push(`${model}: skipped (${known.why})`);
      if (known.why.includes("quota")) lastStatus = 429;
      continue;
    }
    let safe = false;
    let busyRetries = 0;
    while (true) {
      const started = Date.now();
      const attempt = new AbortController();
      const timer = setTimeout(() => attempt.abort(), ATTEMPT_MS);
      const onOuterAbort = () => attempt.abort();
      if (signal?.aborted) {
        clearTimeout(timer);
        throw new LlmError("The analysis timed out.", 504);
      }
      signal?.addEventListener("abort", onOuterAbort);
      let res: Response;
      let data: any;
      try {
        res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          signal: attempt.signal,
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: "user", parts: [{ text: user }] }],
            generationConfig: generationConfig(model, safe, opts.schema, opts.thinkingLevel),
          }),
        });
        data = res.ok ? await res.json() : null; // the body streams in after headers; keep it under the same timeout
      } catch (err) {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onOuterAbort);
        if (signal?.aborted) throw new LlmError("The analysis timed out.", 504);
        attempts.push(
          (err as Error).name === "AbortError"
            ? `${model}: no answer within ${Math.round(ATTEMPT_MS / 1000)} s (overloaded)`
            : `${model}: network error (${(err as Error).message})`,
        );
        lastStatus = 503;
        if ((err as Error).name === "AbortError") markBusy(model);
        break; // next model
      }
      clearTimeout(timer);
      signal?.removeEventListener("abort", onOuterAbort);

      if (res.status === 429 || res.status >= 500) {
        const detail = googleMessage(await res.text().catch(() => ""));
        attempts.push(`${model}: HTTP ${res.status}${detail ? ` (${detail})` : ""}`);
        lastStatus = res.status === 429 ? 429 : 503;
        // Daily free-tier quota used up: remember it until the reset so we don't keep asking.
        if (res.status === 429 && /free_tier_requests|per day|PerDay/i.test(detail)) {
          markUnavailable(model, "daily quota used up", nextPacificMidnight());
        }
        // Overloaded: wait briefly and retry once. Quota used up (429): retrying only wastes requests, so fall back now.
        // With a backup provider configured, don't spend long waiting on a busy Gemini.
        if (res.status !== 429) markBusy(model);
        const waits = opts.busyWaits ?? (opts.quick ? [2_000] : [3_000, 8_000, 15_000]);
        if (res.status !== 429 && busyRetries < waits.length && Date.now() - startedAll + waits[busyRetries] < BUDGET_MS) {
          await sleep(waits[busyRetries]);
          busyRetries++;
          continue;
        }
        break;
      }
      if (res.status === 404) {
        attempts.push(`${model}: not available to this API key (HTTP 404)`);
        markUnavailable(model, "not available to this key", Date.now() + 86_400_000);
        break; // retired model: next one
      }
      if (res.status === 400 && !safe) {
        attempts.push(`${model}: HTTP 400 with full settings (${googleMessage(await res.text().catch(() => ""))}); retrying with essentials only`);
        safe = true;
        continue;
      }
      if (!res.ok) {
        const detail = googleMessage(await res.text().catch(() => ""));
        if (res.status === 401 || res.status === 403) {
          throw new LlmError(`Gemini refused the API key (HTTP ${res.status}). Check GEMINI_API_KEY. ${detail}`, 502);
        }
        attempts.push(`${model}: HTTP ${res.status} (${detail})`);
        lastStatus = res.status === 400 ? 400 : 502;
        break;
      }

      const cand = data?.candidates?.[0];
      const text: string | undefined = cand?.content?.parts
        ?.filter((p: { thought?: boolean }) => !p.thought)
        .map((p: { text?: string }) => p.text ?? "")
        .join("");
      if (!text) {
        attempts.push(`${model}: empty answer (finish reason ${cand?.finishReason ?? data?.promptFeedback?.blockReason ?? "unknown"})`);
        break;
      }
      try {
        const u = data?.usageMetadata ?? {};
        return {
          json: JSON.parse(text),
          model,
          latencyMs: Date.now() - started,
          usage: {
            input: u.promptTokenCount ?? 0,
            output: u.candidatesTokenCount ?? 0,
            thinking: u.thoughtsTokenCount ?? 0,
            cached: u.cachedContentTokenCount ?? 0,
          },
        };
      } catch {
        attempts.push(`${model}: malformed JSON (finish reason ${cand?.finishReason})`);
        break;
      }
    }
  }

  const summary = attempts.join("; ");
  if (lastStatus === 503) {
    throw new LlmError(`Gemini is busy right now (overloaded). Please try again in a minute. Details: ${summary}`, 503);
  }
  if (lastStatus === 429) {
    throw new LlmError(`The free Gemini quota is used up for now (rate limit). Wait a minute and try again. Details: ${summary}`, 429);
  }
  throw new LlmError(`The model could not produce a report. Details: ${summary || "no model available"}`, lastStatus);
}

/** Pull the human-readable message out of a Google error body. */
function googleMessage(body: string): string {
  let msg: string;
  try {
    msg = String(JSON.parse(body)?.error?.message ?? "");
  } catch {
    msg = body;
  }
  // Quota errors: keep the first sentence and the metric/limit lines, drop the boilerplate links.
  const quota = msg.match(/Quota exceeded for metric: [^\n,]+(?:, limit: \d+)?/);
  const first = msg.split(/(?<=\.)\s/)[0];
  return (quota ? `${first} ${quota[0]}` : first).slice(0, 240);
}
