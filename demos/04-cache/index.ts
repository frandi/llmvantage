/**
 * Demo 04 — Cache token validation.
 *
 * Fires real provider calls and prints both the raw provider usage block and
 * the normalized `tokens` field side-by-side, so cache-extraction correctness
 * is visually verifiable. Each provider's caches are sensitive to ordering
 * and identical-prefix length; runs are sequential and the prompt is padded
 * past each provider's minimum cache size when `--prompt-size large`.
 *
 * Usage:
 *   tsx index.ts --provider anthropic --runs 2 --cache-mode explicit
 *   tsx index.ts --provider openai    --runs 2 --prompt-size large
 *   tsx index.ts --provider gemini    --runs 2 --prompt-size large
 */
import "dotenv/config";
import "llmvantage";
import { parseArgs } from "node:util";
import { observer, type LLMEvent, type Sink } from "llmvantage";
import {
  normalizeTokens,
  type EventWithTokens,
} from "llmvantage/plugins/normalize-tokens";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";

// ---- CLI ------------------------------------------------------------------

type Provider = "anthropic" | "openai" | "gemini";
type PromptSize = "small" | "large";
type CacheMode = "auto" | "explicit" | "off";
type Ttl = "5m" | "1h";

const DEFAULT_MODEL: Record<Provider, string> = {
  anthropic: "claude-haiku-4-5",
  openai: "gpt-5.4-nano",
  gemini: "gemini-3.5-flash",
};

const { values } = parseArgs({
  options: {
    provider: { type: "string" },
    model: { type: "string" },
    runs: { type: "string", default: "2" },
    "prompt-size": { type: "string", default: "large" },
    "cache-mode": { type: "string", default: "auto" },
    ttl: { type: "string", default: "5m" },
  },
});

const provider = values.provider as Provider | undefined;
if (!provider || !["anthropic", "openai", "gemini"].includes(provider)) {
  console.error("ERROR: --provider must be one of anthropic | openai | gemini");
  process.exit(1);
}
const model = (values.model as string | undefined) ?? DEFAULT_MODEL[provider];
const runs = Math.max(1, Number(values.runs));
if (!Number.isFinite(runs)) {
  console.error("ERROR: --runs must be a positive integer");
  process.exit(1);
}
const promptSize = (values["prompt-size"] as PromptSize) ?? "large";
if (!["small", "large"].includes(promptSize)) {
  console.error("ERROR: --prompt-size must be small | large");
  process.exit(1);
}
const cacheMode = (values["cache-mode"] as CacheMode) ?? "auto";
if (!["auto", "explicit", "off"].includes(cacheMode)) {
  console.error("ERROR: --cache-mode must be auto | explicit | off");
  process.exit(1);
}
const ttl = (values.ttl as Ttl) ?? "5m";
if (!["5m", "1h"].includes(ttl)) {
  console.error("ERROR: --ttl must be 5m | 1h");
  process.exit(1);
}

console.log(
  `[demo] provider=${provider} model=${model} runs=${runs} prompt-size=${promptSize} cache-mode=${cacheMode} ttl=${ttl}`
);

// ---- Validation sink ------------------------------------------------------

let runIdx = 0;
const totals = { cachedRead: 0, cacheCreated: 0, runsWithCacheHit: 0 };

const printerSink: Sink = (event: LLMEvent) => {
  runIdx++;
  const { tokens } = event as EventWithTokens;
  const rawUsage =
    (event.response as { usage?: unknown; usageMetadata?: unknown } | null | undefined)
      ?.usage ??
    (event.response as { usageMetadata?: unknown } | null | undefined)?.usageMetadata;

  console.log(
    `\n[run #${runIdx}] provider=${event.provider} endpoint=${event.endpoint} latency=${event.latencyMs.toFixed(0)}ms`
  );
  if (tokens) {
    const cacheParts: string[] = [];
    if (tokens.cachedInputTokens !== undefined) cacheParts.push(`cached=${tokens.cachedInputTokens}`);
    if (tokens.cacheCreationInputTokens !== undefined)
      cacheParts.push(`cacheCreation=${tokens.cacheCreationInputTokens}`);
    console.log(
      `  normalized: input=${tokens.inputTokens} output=${tokens.outputTokens} total=${tokens.totalTokens}` +
        (cacheParts.length ? `  ${cacheParts.join(" ")}` : "  (no cache fields)")
    );
    if ((tokens.cachedInputTokens ?? 0) > 0) {
      totals.cachedRead += tokens.cachedInputTokens ?? 0;
      totals.runsWithCacheHit++;
    }
    totals.cacheCreated += tokens.cacheCreationInputTokens ?? 0;
  } else {
    console.log("  normalized: tokens=null");
  }
  console.log("  raw usage:", JSON.stringify(rawUsage, null, 2)?.replace(/\n/g, "\n  "));
};

observer
  .use(normalizeTokens)
  .pipe(printerSink)
  .onError((err) => console.warn("[llmvantage]", err.phase, err.error.message));

// ---- Prompt construction --------------------------------------------------

const SHORT_SYSTEM =
  "You are a terse assistant. Reply in <=5 words.";

// ~6 KB block of fixed prose so identical-prefix caches can actually form.
// Anthropic's 5m cache requires a meaningful breakpoint; OpenAI's auto-cache
// needs >=1024 tokens; Gemini implicit cache typically kicks in around
// 1k-4k tokens depending on the model. ~6 KB safely clears all three.
const LONG_BLOCK = (() => {
  const para =
    "You are a meticulous assistant who answers in one short sentence. " +
    "Below is fixed reference material that should be cached on the provider side " +
    "so repeated calls with the same preamble can be served from cache rather than " +
    "reprocessed. The text is intentionally long, fixed, and identical across runs. ";
  return para.repeat(80);
})();

const systemPrompt = promptSize === "large" ? LONG_BLOCK : SHORT_SYSTEM;
const userPrompt = "In one word, what color is the sky on a clear day?";

// ---- Provider runners -----------------------------------------------------

async function runAnthropic(): Promise<void> {
  const client = new Anthropic();
  // 5m is the default TTL; only attach an explicit `ttl` field for 1h, which
  // requires the extended-cache-ttl beta header. Specifying `ttl: "5m"`
  // without that header can cause the cache_control marker to be ignored.
  const cacheControl =
    ttl === "1h"
      ? { type: "ephemeral" as const, ttl: "1h" as const }
      : { type: "ephemeral" as const };
  const systemBlocks =
    cacheMode === "explicit"
      ? [{ type: "text" as const, text: systemPrompt, cache_control: cacheControl }]
      : [{ type: "text" as const, text: systemPrompt }];

  const requestOpts =
    cacheMode === "explicit" && ttl === "1h"
      ? { headers: { "anthropic-beta": "extended-cache-ttl-2025-04-11" } }
      : undefined;

  for (let i = 1; i <= runs; i++) {
    console.log(`\n[app] anthropic call ${i}/${runs}...`);
    await client.messages.create(
      {
        model,
        max_tokens: 32,
        system: systemBlocks,
        messages: [{ role: "user", content: userPrompt }],
      },
      requestOpts
    );
  }
}

async function runOpenAI(): Promise<void> {
  const client = new OpenAI();
  for (let i = 1; i <= runs; i++) {
    console.log(`\n[app] openai call ${i}/${runs}...`);
    await client.responses.create({
      model,
      instructions: systemPrompt,
      input: userPrompt,
      max_output_tokens: 32,
      reasoning: { effort: "none" },
    });
  }
}

async function runGemini(): Promise<void> {
  const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  for (let i = 1; i <= runs; i++) {
    console.log(`\n[app] gemini call ${i}/${runs}...`);
    await client.models.generateContent({
      model,
      contents: `${systemPrompt}\n\n${userPrompt}`,
      config: {
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
  }
}

// ---- Main -----------------------------------------------------------------

const runners: Record<Provider, () => Promise<void>> = {
  anthropic: runAnthropic,
  openai: runOpenAI,
  gemini: runGemini,
};

try {
  await runners[provider]();
} catch (err) {
  console.error(`\n[app] ${provider} call failed:`, (err as Error).message);
  process.exitCode = 1;
}

// Give any in-flight observer callbacks time to flush. The observer pipeline
// runs after the SDK call resolves (via setImmediate + body draining), so a
// single tick is not enough — wait a short interval to let it complete.
await new Promise((r) => setTimeout(r, 200));

console.log(
  `\n[summary] cache hits on ${totals.runsWithCacheHit}/${runs} runs — total cache-read tokens=${totals.cachedRead}, total cache-creation tokens=${totals.cacheCreated}`
);
