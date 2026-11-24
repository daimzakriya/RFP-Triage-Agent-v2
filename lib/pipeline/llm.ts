/**
 * One entry point for every model call in the v2 pipeline.
 * Gemini first (model list per task), then the OpenAI-compatible backup, with
 * usage logging. RFP_FIXTURE_MODE=1 replays recorded answers for offline tests.
 */
import { callGemini, LlmError, type LlmResult, type LlmUsage } from "../gemini";
import { callOpenAICompat, fallbackConfigured } from "../openai-compat";

export interface TaskCall {
  task: string; // e.g. "extract.schedule", "reason"
  system: string;
  user: string;
  schema: object; // Gemini OpenAPI-style schema
  models: string[];
  thinkingLevel?: "low" | "medium" | "high";
  signal?: AbortSignal;
  /** Use the backup provider if every Gemini model fails. Off for the parallel extraction calls:
   *  the free backup allows ~20k tokens/minute, so the whole-document single call is the backup instead. */
  allowBackup?: boolean;
}

export interface TaskResult extends LlmResult {
  task: string;
  provider: string;
  usage: LlmUsage;
}

/** Test hook: return a recorded answer for a task, or null to call the real model. */
type FixtureFn = (task: string, user: string) => unknown | null;
let fixtureProvider: FixtureFn | null = null;
export function setFixtureProvider(fn: FixtureFn | null) {
  fixtureProvider = fn;
}

const ZERO: LlmUsage = { input: 0, output: 0, thinking: 0, cached: 0 };

export function log(event: string, data: Record<string, unknown>) {
  if (process.env.NODE_ENV === "test" || process.env.VITEST || process.env.LOG_QUIET) return;
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));
}

export async function callTask(c: TaskCall): Promise<TaskResult> {
  if (fixtureProvider) {
    const json = fixtureProvider(c.task, c.user);
    if (json != null) return { task: c.task, json, model: "fixture", provider: "Fixture (offline test mode)", latencyMs: 0, usage: ZERO };
  }

  const backup = fallbackConfigured() && c.allowBackup !== false;
  try {
    const r = await callGemini(c.system, c.user, c.signal, {
      quick: backup,
      schema: c.schema,
      models: c.models,
      thinkingLevel: c.thinkingLevel,
    });
    const res: TaskResult = { ...r, task: c.task, provider: "Google Gemini", usage: r.usage ?? ZERO };
    log("llm.ok", { task: c.task, provider: res.provider, model: res.model, ms: res.latencyMs, ...res.usage });
    return res;
  } catch (err) {
    const status = err instanceof LlmError ? err.status : 0;
    log("llm.fail", { task: c.task, provider: "Google Gemini", status, error: (err as Error).message.slice(0, 300) });
    if (!backup || ![429, 502, 503].includes(status)) throw err;
    try {
      const r = await callOpenAICompat(c.system, c.user, c.signal, { schema: c.schema });
      const res: TaskResult = { ...r, task: c.task, provider: `${r.provider ?? "Backup"} (backup)`, usage: r.usage ?? ZERO };
      log("llm.ok", { task: c.task, provider: res.provider, model: res.model, ms: res.latencyMs, ...res.usage });
      return res;
    } catch (err2) {
      log("llm.fail", { task: c.task, provider: "backup", error: (err2 as Error).message.slice(0, 300) });
      const first = (err as Error).message.split(" Details:")[0];
      throw new LlmError(`${first} The backup model also failed: ${(err2 as Error).message}`, (err2 as LlmError).status ?? 503);
    }
  }
}

export function sumUsage(rs: { usage: LlmUsage }[]): LlmUsage {
  return rs.reduce(
    (a, r) => ({
      input: a.input + r.usage.input,
      output: a.output + r.usage.output,
      thinking: a.thinking + r.usage.thinking,
      cached: a.cached + r.usage.cached,
    }),
    { ...ZERO },
  );
}

/**
 * Model lists per role, configurable. On the free tier every model has its OWN quota
 * (Flash-Lite 500/day, the Flash models ~20/day each), and overloads hit models
 * separately, so spreading across several models is what keeps the app available.
 * Extraction uses only the high-quota Flash-Lite models; the scarce 3.8 Flash is
 * reserved for the single reasoning call per RFP.
 */
export function extractionModels(): string[] {
  // High-throughput extraction: two Flash-Lite models (15 RPM / 500 RPD each). If both are
  // overloaded, overflow to the regular Flash models, which run on separate capacity and have
  // their own quotas (5 RPM / 20 RPD each). 3.8 Flash is never used here; it is kept for reasoning.
  return list(process.env.EXTRACT_MODELS, ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.6-flash", "gemini-3-flash-preview"]);
}
export function reasoningModels(): string[] {
  // Final evaluation: 3.8 Flash when available (5 RPM / 20 RPD), otherwise the Flash-Lite models.
  return list(process.env.REASON_MODELS, ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]);
}
function list(env: string | undefined, dflt: string[]) {
  const v = (env ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return v.length ? v : dflt;
}
