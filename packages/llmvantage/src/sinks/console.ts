import type { LLMEvent, Sink } from "../types.js";

export const consoleSink: Sink = (event: LLMEvent): void => {
  const enriched = event as LLMEvent & { tokens?: unknown };
  const out: Record<string, unknown> = {
    t: event.timestamp,
    provider: event.provider,
    endpoint: event.endpoint,
    latencyMs: Math.round(event.latencyMs),
    streaming: event.streaming,
  };
  if (enriched.tokens !== undefined) out.tokens = enriched.tokens;
  console.log(JSON.stringify(out));
};
