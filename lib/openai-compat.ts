/**
 * Backup provider: any OpenAI-compatible chat API (default: Mistral's free tier).
 * Used only when Gemini is overloaded or out of quota, so a reviewer still gets a report.
 *
 *   FALLBACK_API_KEY   required to enable it (e.g. a Mistral key from console.mistral.ai)
 *   FALLBACK_BASE_URL  default https://api.mistral.ai/v1
 *   FALLBACK_MODEL     default mistral-large-2512 (Mistral free tier: 250,000 tokens/min,
 *                      vs 20,000 for mistral-small, which is too little for 3 RFP-sized calls a minute)
 */
import { GEMINI_RESPONSE_SCHEMA, LlmError, type LlmResult } from "./gemini";

export function fallbackConfigured(): boolean {
  return !!(process.env.FALLBACK_API_KEY || process.env.MISTRAL_API_KEY);
}

/** Convert Gemini's OpenAPI-style schema into standard JSON Schema. */
export function toJsonSchema(node: any): any {
  if (Array.isArray(node)) return node.map(toJsonSchema);
  if (!node || typeof node !== "object") return node;
  const out: any = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "propertyOrdering" || k === "nullable") continue;
    if (k === "type") out.type = String(v).toLowerCase();
    else if (k === "properties") out.properties = Object.fromEntries(Object.entries(v as object).map(([pk, pv]) => [pk, toJsonSchema(pv)]));
    else out[k] = toJsonSchema(v);
  }
  if (node.nullable) out.type = [out.type, "null"];
  if (out.type === "object") out.additionalProperties = false;
  return out;
}

// Free tiers allow about one request per second: serialize backup calls and space them out.
let queue: Promise<unknown> = Promise.resolve();
let lastCallAt = 0;
function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = Math.max(0, lastCallAt + 1_200 - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();
    return fn();
  });
  queue = run.catch(() => undefined);
  return run;
}

export async function callOpenAICompat(
  system: string,
  user: string,
  signal?: AbortSignal,
  opts: { schema?: object } = {},
): Promise<LlmResult> {
  const key = process.env.FALLBACK_API_KEY || process.env.MISTRAL_API_KEY;
  if (!key) throw new LlmError("No backup model is configured.", 503);
  const base = (process.env.FALLBACK_BASE_URL || "https://api.mistral.ai/v1").replace(/\/$/, "");
  const model = process.env.FALLBACK_MODEL || "mistral-large-2512";
  const schema = toJsonSchema(opts.schema ?? GEMINI_RESPONSE_SCHEMA);

  // Plain JSON mode is supported by every OpenAI-compatible provider; the schema is spelled out in the
  // prompt and zod validates the answer. Free tiers allow ~1 request/second, so on 429 we wait and retry.
  // Per-minute token windows need longer waits than per-second ones; honour Retry-After when given.
  const waits = [5_000, 15_000, 25_000];
  const budgetMs = Number(process.env.FALLBACK_RETRY_BUDGET_MS ?? 60_000);
  const startedAll = Date.now();
  const problems: string[] = [];
  for (let attempt = 0; attempt <= waits.length; attempt++) {
    const started = Date.now();
    let res: Response;
    try {
      res = await throttled(() => fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        signal,
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: Number(process.env.FALLBACK_MAX_TOKENS ?? 8000),
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: `${system}\n\nReturn ONLY one JSON object that matches this JSON Schema exactly:\n${JSON.stringify(schema)}`,
            },
            { role: "user", content: user },
          ],
        }),
      }));
    } catch (err) {
      if (signal?.aborted) throw new LlmError("The analysis timed out.", 504);
      throw new LlmError(`Could not reach the backup model (${(err as Error).message}).`, 503);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < waits.length) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = Math.min(60_000, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : waits[attempt]);
      if (Date.now() - startedAll + wait < budgetMs) {
        problems.push(`${model}: HTTP ${res.status}, retrying in ${Math.round(wait / 1000)} s`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      let msg = body;
      try {
        const j = JSON.parse(body);
        msg = j?.message ?? j?.error?.message ?? j?.detail ?? body;
      } catch {
        /* keep text */
      }
      throw new LlmError(
        `Backup model ${model}: HTTP ${res.status} (${String(typeof msg === "string" ? msg : JSON.stringify(msg)).slice(0, 200)})${problems.length ? ` after ${problems.length} retr${problems.length === 1 ? "y" : "ies"}` : ""}`,
        res.status === 429 ? 429 : res.status === 401 || res.status === 403 ? 502 : 503,
      );
    }
    const data = await res.json();
    const text: string = data?.choices?.[0]?.message?.content ?? "";
    try {
      const u = data?.usage ?? {};
      return {
        json: JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "")),
        model,
        latencyMs: Date.now() - started,
        usage: { input: u.prompt_tokens ?? 0, output: u.completion_tokens ?? 0, thinking: u.completion_tokens_details?.reasoning_tokens ?? 0, cached: u.prompt_tokens_details?.cached_tokens ?? 0 },
      };
    } catch {
      problems.push(`${model}: answer was not valid JSON (finish reason ${data?.choices?.[0]?.finish_reason})`);
      break;
    }
  }
  throw new LlmError(`The backup model could not produce a report. ${problems.join("; ")}`, 502);
}
