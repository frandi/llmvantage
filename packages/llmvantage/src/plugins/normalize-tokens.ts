import type { LLMEvent, Plugin } from "../types.js";

export type NormalizedTokens = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
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
    return fromPair(usage.input_tokens, usage.output_tokens);
  }

  if (event.provider === "openai" && isObject(usage)) {
    // Responses API uses input_tokens/output_tokens.
    // Chat Completions uses prompt_tokens/completion_tokens.
    const input = usage.input_tokens ?? usage.prompt_tokens;
    const output = usage.output_tokens ?? usage.completion_tokens;
    return fromPair(input, output, usage.total_tokens);
  }

  if (event.provider === "gemini" && isObject(meta)) {
    return fromPair(meta.promptTokenCount, meta.candidatesTokenCount);
  }

  return null;
}

function fromPair(
  input: unknown,
  output: unknown,
  total?: unknown
): NormalizedTokens | null {
  const inputTokens = typeof input === "number" ? input : NaN;
  const outputTokens = typeof output === "number" ? output : NaN;
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) return null;
  const totalTokens = typeof total === "number" ? total : inputTokens + outputTokens;
  return { inputTokens, outputTokens, totalTokens };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
