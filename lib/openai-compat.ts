/**
 * Backup provider: any OpenAI-compatible chat API (default: Mistral's free tier).
 * Used only when Gemini is overloaded or out of quota, so a reviewer still gets a report.
 *
 *   FALLBACK_API_KEY   required to enable it (e.g. a Mistral key from console.mistral.ai)
 *   FALLBACK_BASE_URL  default https://api.mistral.ai/v1
 *   FALLBACK_MODEL     default mistral-small-latest (the model the Mistral free tier serves;
 *                      mistral-large returns 403 "not available in your subscription tier").
 *                      Its 20,000 tokens/minute fits ONE RFP-sized call a minute, so the app
 *                      uses the backup for a single whole-document call, not parallel workers.
 */
import { GEMINI_RESPONSE_SCHEMA, LlmError, type LlmResult } from "./gemini";

interface BackupProvider {
  name: string;
  key: string;
  base: string;
  models: string[];
}

/**
 * Backup providers, tried in order; each with a list of models tried in order.
 *  FALLBACK_*  : default Mistral. FALLBACK_MODELS defaults to DeepSeek V4.1 Flash (served by
 *                Mistral; no tokens-per-minute cap on our free account's limits page) and then
 *                mistral-small-latest (20,000 tokens/min on the free tier).
 *  FALLBACK2_* : optional second OpenAI-compatible provider, e.g. NVIDIA (build.nvidia.com,
 *                Nemotron models) or OpenRouter (":free" models). Needs its own key.
 */
export function backupProviders(): BackupProvider[] {
  const out: BackupProvider[] = [];
  const k1 = process.env.FALLBACK_API_KEY || process.env.MISTRAL_API_KEY;
  if (k1) {
    out.push({
      name: "Mistral",
      key: k1,
      base: (process.env.FALLBACK_BASE_URL || "https://api.mistral.ai/v1").replace(/\/$/, ""),
      models: list(process.env.FALLBACK_MODELS ?? process.env.FALLBACK_MODEL, ["deepseek-v4-1-flash-1017", "mistral-small-latest"]),
    });
  }
  // NVIDIA build.nvidia.com free endpoint (Nemotron). Only NVIDIA_API_KEY is needed.
  const kn = process.env.NVIDIA_API_KEY;
  if (kn) {
    out.push({
      name: "NVIDIA",
      key: kn,
      base: (process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1").replace(/\/$/, ""),
      models: list(process.env.NVIDIA_MODELS, ["nvidia/nemotron-3-super-120b-a12b", "nvidia/nemotron-3-ultra-550b-a55b"]),
    });
  }
  const k2 = process.env.FALLBACK2_API_KEY;
  if (k2 && process.env.FALLBACK2_BASE_URL && (process.env.FALLBACK2_MODELS || process.env.FALLBACK2_MODEL)) {
    out.push({
      name: process.env.FALLBACK2_NAME || new URL(process.env.FALLBACK2_BASE_URL).hostname,
      key: k2,
      base: process.env.FALLBACK2_BASE_URL.replace(/\/$/, ""),
      models: list(process.env.FALLBACK2_MODELS ?? process.env.FALLBACK2_MODEL, []),
    });
  }
  return out;
}
function list(v: string | undefined, dflt: string[]) {
  const a = (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  return a.length ? a : dflt;
}

export function fallbackConfigured(): boolean {
  return backupProviders().length > 0;
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
): Promise<LlmResult & { provider?: string }> {
  const providers = backupProviders();
  if (!providers.length) throw new LlmError("No backup model is configured.", 503);
  const problems: string[] = [];
  let lastStatus = 503;
  for (const p of providers) {
    for (const model of p.models) {
      try {
        const r = await callOneModel(p, model, system, user, signal, opts);
        return { ...r, provider: p.name };
      } catch (err) {
        if (signal?.aborted) throw err;
        const e = err as LlmError;
        problems.push(e.message);
        lastStatus = e.status ?? 503;
        // 400/403/404: this model isn't usable with this key → next model. 429/5xx: next model too.
      }
    }
  }
  throw new LlmError(problems.join("; "), lastStatus === 429 ? 429 : 503);
}

async function callOneModel(
  p: BackupProvider,
  model: string,
  system: string,
  user: string,
  signal: AbortSignal | undefined,
  opts: { schema?: object },
): Promise<LlmResult> {
  const key = p.key;
  const base = p.base;
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
        `Backup ${p.name} ${model}: HTTP ${res.status} (${String(typeof msg === "string" ? msg : JSON.stringify(msg)).slice(0, 200)})${problems.length ? ` after ${problems.length} retr${problems.length === 1 ? "y" : "ies"}` : ""}`,
        res.status === 429 ? 429 : res.status === 401 || res.status === 403 ? 502 : 503,
      );
    }
    const data = await res.json();
    const text: string = data?.choices?.[0]?.message?.content ?? "";
    try {
      const u = data?.usage ?? {};
      return {
        json: parseJsonLoose(text),
        model,
        latencyMs: Date.now() - started,
        usage: { input: u.prompt_tokens ?? 0, output: u.completion_tokens ?? 0, thinking: u.completion_tokens_details?.reasoning_tokens ?? 0, cached: u.prompt_tokens_details?.cached_tokens ?? 0 },
      };
    } catch {
      problems.push(`${model}: answer was not valid JSON (finish reason ${data?.choices?.[0]?.finish_reason})`);
      break;
    }
  }
  throw new LlmError(`Backup ${p.name} ${model} could not produce a report. ${problems.join("; ")}`, 502);
}

/** Parse a JSON object from a model answer that may include <think> blocks, code fences or prose. */
export function parseJsonLoose(text: string): unknown {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/```(?:json)?/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const a = cleaned.indexOf("{");
    const b = cleaned.lastIndexOf("}");
    if (a >= 0 && b > a) return JSON.parse(cleaned.slice(a, b + 1));
    throw new Error("no JSON object in answer");
  }
}
