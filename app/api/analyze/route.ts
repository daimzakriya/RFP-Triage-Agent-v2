import { NextResponse } from "next/server";
import { z } from "zod";
import { analyzeDocument, buildReport, defaultPipeline } from "@/lib/analyze";
import { setFixtureProvider } from "@/lib/pipeline/llm";
import { LlmError } from "@/lib/gemini";
import { LIMITS } from "@/lib/limits";
import { findFixture, v2Fixture } from "@/lib/fixtures";

export const runtime = "nodejs";
export const maxDuration = 300; // Vercel Hobby with Fluid compute (default for new projects) allows up to 300 s

const BodySchema = z.object({
  fileName: z.string().min(1).max(260),
  pages: z.array(z.string().max(60_000)).min(1).max(LIMITS.maxPages),
});

// Best-effort per-instance rate limit to protect the free model quota on a public link.
const hits = new Map<string, number[]>();
function rateLimited(ip: string, max = Number(process.env.RATE_LIMIT_PER_10_MIN ?? 12)) {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 600_000);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > max;
}

function error(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: Request) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (rateLimited(ip)) return error("Too many analyses from this address. Please wait a few minutes.", 429);

  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await req.json());
  } catch {
    return error(`Invalid request. Send { fileName, pages[] } with 1–${LIMITS.maxPages} pages of text.`, 400);
  }
  const chars = body.pages.reduce((n, p) => n + p.length, 0);
  if (chars > LIMITS.maxChars) {
    return error(`This document has ${chars.toLocaleString()} characters of text. The limit is ${LIMITS.maxChars.toLocaleString()}. Remove large appendices and try again.`, 413);
  }
  if (chars < 500) return error("There is too little text in this document to analyse.", 422);

  // Offline test mode (never enable in production): replays recorded model answers for the two
  // challenge sample RFPs so the whole pipeline can be exercised without an API key.
  if (process.env.RFP_FIXTURE_MODE === "1") {
    const fx = findFixture(body.pages);
    if (fx) {
      await new Promise((r) => setTimeout(r, 1200));
      if (defaultPipeline() === "v1") {
        return NextResponse.json({
          ...buildReport({ pages: body.pages, fileName: body.fileName, modelJson: fx.json, model: { provider: "Fixture (offline test mode)", name: fx.name, latencyMs: 0 } }),
          pipeline: "v1",
        });
      }
      setFixtureProvider(v2Fixture);
      try {
        return NextResponse.json(await analyzeDocument(body.pages, body.fileName, undefined, "v2"));
      } finally {
        setFixtureProvider(null);
      }
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 285_000);
  try {
    const report = await analyzeDocument(body.pages, body.fileName, controller.signal);
    return NextResponse.json(report);
  } catch (err) {
    if (err instanceof LlmError) return error(err.message, err.status);
    console.error(err);
    return error("Something went wrong while analysing the document.", 500);
  } finally {
    clearTimeout(timer);
  }
}
