import { afterEach, describe, expect, it, vi } from "vitest";
import { callGemini, GEMINI_RESPONSE_SCHEMA, generationConfig, LlmError } from "@/lib/gemini";
import rfp2 from "@/fixtures/sample-rfp-2.model.json";

const ok = (json: unknown) =>
  new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(json) }] } }] }), { status: 200 });

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GEMINI_API_KEY;
});

describe("Gemini client (mocked network)", () => {
  it("sends the key as a header (not in the URL) with the JSON schema, and parses the answer", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => ok(rfp2));
    vi.stubGlobal("fetch", fetchMock);
    const res = await callGemini("sys", "user");
    expect(res.json).toEqual(rfp2);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("gemini-3.8-flash:generateContent");
    expect(url).not.toContain("test-key");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("test-key");
    const body = JSON.parse(init.body as string);
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseSchema).toEqual(GEMINI_RESPONSE_SCHEMA);
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low" });
    expect(body.generationConfig.temperature).toBeUndefined();
  });

  it("falls back to the next model when rate-limited", async () => {
    process.env.GEMINI_API_KEY = "k";
    process.env.GEMINI_RETRY_BUDGET_MS = "0";
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("{}", { status: 429 })).mockResolvedValueOnce(ok(rfp2));
    vi.stubGlobal("fetch", fetchMock);
    const res = await callGemini("s", "u");
    delete process.env.GEMINI_RETRY_BUDGET_MS;
    expect(res.model).toBe("gemini-3.5-flash-lite");
  });

  it("waits and retries the same model when it is overloaded (503)", async () => {
    vi.useFakeTimers();
    process.env.GEMINI_API_KEY = "k";
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('{"error":{"message":"The model is overloaded."}}', { status: 503 })).mockResolvedValueOnce(ok(rfp2));
    vi.stubGlobal("fetch", fetchMock);
    const p = callGemini("s", "u");
    await vi.advanceTimersByTimeAsync(3_500);
    const res = await p;
    vi.useRealTimers();
    expect(res.model).toBe("gemini-3.8-flash");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("explains what each model said when all are overloaded", async () => {
    process.env.GEMINI_API_KEY = "k";
    process.env.GEMINI_RETRY_BUDGET_MS = "0";
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":{"message":"The model is overloaded."}}', { status: 503 })));
    const err = await callGemini("s", "u").catch((e) => e);
    delete process.env.GEMINI_RETRY_BUDGET_MS;
    expect(err.status).toBe(503);
    expect(err.message).toMatch(/gemini-3.8-flash: HTTP 503 \(The model is overloaded.\)/);
    expect(err.message).toMatch(/gemini-3.5-flash-lite/);
    expect(err.message).toMatch(/gemini-3.7-flash/);
  });

  it("does not retry a model whose quota is used up (429); it falls back at once", async () => {
    process.env.GEMINI_API_KEY = "k";
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('{"error":{"message":"You exceeded your current quota."}}', { status: 429 })).mockResolvedValueOnce(ok(rfp2));
    vi.stubGlobal("fetch", fetchMock);
    const res = await callGemini("s", "u");
    expect(res.model).toBe("gemini-3.5-flash-lite");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up on a model that hangs and moves to the backup", async () => {
    process.env.GEMINI_API_KEY = "k";
    process.env.GEMINI_ATTEMPT_TIMEOUT_MS = "50";
    const hang = (_u: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    const fetchMock = vi.fn().mockImplementationOnce(hang).mockResolvedValueOnce(ok(rfp2));
    vi.stubGlobal("fetch", fetchMock);
    const res = await callGemini("s", "u");
    delete process.env.GEMINI_ATTEMPT_TIMEOUT_MS;
    expect(res.model).toBe("gemini-3.5-flash-lite");
  });

  it("moves to the fallback model when a model is retired (404)", async () => {
    process.env.GEMINI_API_KEY = "k";
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('{"error":{"code":404}}', { status: 404 })).mockResolvedValueOnce(ok(rfp2));
    vi.stubGlobal("fetch", fetchMock);
    expect((await callGemini("s", "u")).model).toBe("gemini-3.5-flash-lite");
  });

  it("retries once with plain settings when a model rejects an optional setting (400)", async () => {
    process.env.GEMINI_API_KEY = "k";
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("bad thinking", { status: 400 })).mockResolvedValueOnce(ok(rfp2));
    vi.stubGlobal("fetch", fetchMock);
    const res = await callGemini("s", "u");
    expect(res.model).toBe("gemini-3.8-flash");
    const body = JSON.parse((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body as string);
    expect(body.generationConfig.thinkingConfig).toBeUndefined();
  });

  it("uses thinkingBudget and temperature 0 for 2.5 models", () => {
    expect(generationConfig("gemini-2.5-flash")).toMatchObject({ temperature: 0, thinkingConfig: { thinkingBudget: 1024 } });
  });

  it("gives a clear error when the key is missing", async () => {
    await expect(callGemini("s", "u")).rejects.toThrow(/GEMINI_API_KEY/);
  });

  it("reports the quota problem in plain words when every model is rate-limited", async () => {
    process.env.GEMINI_API_KEY = "k";
    process.env.GEMINI_RETRY_BUDGET_MS = "0"; // no waiting in tests
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 429 })));
    const err = await callGemini("s", "u").catch((e) => e);
    delete process.env.GEMINI_RETRY_BUDGET_MS;
    expect(err).toBeInstanceOf(LlmError);
    expect(err.status).toBe(429);
  });
});

describe("backup provider (mocked network)", () => {
  it("switches to the OpenAI-compatible backup when Gemini is overloaded", async () => {
    const { analyzeDocument } = await import("@/lib/analyze");
    const { readFile } = await import("node:fs/promises");
    const { extractPdfPages } = await import("@/lib/pdf");
    const { pages } = await extractPdfPages(new Uint8Array(await readFile("samples/Sample-RFP-2-Larkspur-County-Janitorial.pdf")));
    process.env.GEMINI_API_KEY = "g";
    process.env.FALLBACK_API_KEY = "m";
    process.env.GEMINI_RETRY_BUDGET_MS = "0";
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes("googleapis")) return new Response('{"error":{"message":"high demand"}}', { status: 503 });
      const body = JSON.parse(init.body as string);
      expect(url).toBe("https://api.mistral.ai/v1/chat/completions");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer m");
      expect(body.model).toBe("mistral-small-latest");
      expect(body.response_format.type).toBe("json_object");
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(rfp2) }, finish_reason: "stop" }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const report = await analyzeDocument(pages, "rfp2.pdf", undefined, "v1");
    delete process.env.FALLBACK_API_KEY;
    delete process.env.GEMINI_RETRY_BUDGET_MS;
    expect(report.decision).toBe("NO_BID");
    expect(report.model.provider).toMatch(/Mistral/);
  });

  it("waits and retries the backup on a 1-request-per-second rate limit (429)", async () => {
    vi.useFakeTimers();
    process.env.FALLBACK_API_KEY = "m";
    const { callOpenAICompat } = await import("@/lib/openai-compat");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"message":"Rate limit exceeded"}', { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(rfp2) } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const p = callOpenAICompat("s", "u");
    await vi.advanceTimersByTimeAsync(6_000);
    const res = await p;
    vi.useRealTimers();
    delete process.env.FALLBACK_API_KEY;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.json).toEqual(rfp2);
  });

  it("converts the Gemini schema to valid JSON Schema", async () => {
    const { toJsonSchema } = await import("@/lib/openai-compat");
    const js = toJsonSchema(GEMINI_RESPONSE_SCHEMA);
    expect(js.type).toBe("object");
    expect(js.properties.deadlines.items.properties.date.type).toEqual(["string", "null"]);
    expect(JSON.stringify(js)).not.toMatch(/propertyOrdering|"STRING"/);
  });
});
