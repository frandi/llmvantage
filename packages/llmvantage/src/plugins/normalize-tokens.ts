import type { LLMEvent, Plugin } from "../types.js";

export type NormalizedTokens = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
};

export type EventWithTokens = LLMEvent & { tokens: NormalizedTokens | null };

export const normalizeTokens: Plugin = (event) => {
  const tokens = extract(event);
  return { ...event, tokens } satisfies EventWithTokens;
};

function extract(event: LLMEvent): NormalizedTokens | null {
  const response = event.response;
  if (!response || typeof response !== "object") return null;

  const usage = (response as { usage?: unknown }).usage;
  const meta = (response as { usageMetadata?: unknown }).usageMetadata;

  if (event.provider === "anthropic" && isObject(usage)) {
    return fromPair(usage.input_tokens, usage.output_tokens, undefined, {
      cachedInputTokens: usage.cache_read_input_tokens,
      cacheCreationInputTokens: usage.cache_creation_input_tokens,
    });
  }

  if (event.provider === "openai" && isObject(usage)) {
    // Responses API uses input_tokens/output_tokens.
    // Chat Completions uses prompt_tokens/completion_tokens.
    const input = usage.input_tokens ?? usage.prompt_tokens;
    const output = usage.output_tokens ?? usage.completion_tokens;
    const inputDetails = isObject(usage.input_tokens_details) ? usage.input_tokens_details : undefined;
    const promptDetails = isObject(usage.prompt_tokens_details) ? usage.prompt_tokens_details : undefined;
    return fromPair(input, output, usage.total_tokens, {
      cachedInputTokens: inputDetails?.cached_tokens ?? promptDetails?.cached_tokens,
    });
  }

  if (event.provider === "gemini" && isObject(meta)) {
    return fromPair(meta.promptTokenCount, meta.candidatesTokenCount, undefined, {
      cachedInputTokens: meta.cachedContentTokenCount,
    });
  }

  return null;
}

type CacheFields = {
  cachedInputTokens?: unknown;
  cacheCreationInputTokens?: unknown;
};

function fromPair(
  input: unknown,
  output: unknown,
  total?: unknown,
  cache?: CacheFields
): NormalizedTokens | null {
  const inputTokens = typeof input === "number" ? input : NaN;
  const outputTokens = typeof output === "number" ? output : NaN;
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) return null;
  const totalTokens = typeof total === "number" ? total : inputTokens + outputTokens;
  const result: NormalizedTokens = { inputTokens, outputTokens, totalTokens };
  if (cache) {
    if (typeof cache.cachedInputTokens === "number" && Number.isFinite(cache.cachedInputTokens)) {
      result.cachedInputTokens = cache.cachedInputTokens;
    }
    if (typeof cache.cacheCreationInputTokens === "number" && Number.isFinite(cache.cacheCreationInputTokens)) {
      result.cacheCreationInputTokens = cache.cacheCreationInputTokens;
    }
  }
  return result;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
