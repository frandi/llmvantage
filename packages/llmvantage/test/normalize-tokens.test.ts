import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeTokens,
  type EventWithTokens,
} from "../src/plugins/normalize-tokens.js";
import type { LLMEvent, Provider } from "../src/types.js";

const event = (provider: Provider, response: unknown): LLMEvent => ({
  schemaVersion: "1.1",
  source: "manual",
  provider,
  endpoint: "/x",
  request: {},
  response,
  latencyMs: 1,
  timestamp: new Date().toISOString(),
  streaming: false,
});

const run = async (e: LLMEvent): Promise<EventWithTokens> => {
  const out = await normalizeTokens(e);
  return out as EventWithTokens;
};

describe("normalizeTokens", () => {
  test("Anthropic usage → normalized tokens", async () => {
    const out = await run(
      event("anthropic", {
        id: "msg_1",
        usage: { input_tokens: 10, output_tokens: 25 },
      })
    );
    assert.deepEqual(out.tokens, {
      inputTokens: 10,
      outputTokens: 25,
      totalTokens: 35,
    });
  });

  test("OpenAI Responses API usage (input_tokens / output_tokens)", async () => {
    const out = await run(
      event("openai", {
        id: "resp_1",
        usage: { input_tokens: 7, output_tokens: 13, total_tokens: 20 },
      })
    );
    assert.deepEqual(out.tokens, {
      inputTokens: 7,
      outputTokens: 13,
      totalTokens: 20,
    });
  });

  test("OpenAI Chat Completions usage (prompt_tokens / completion_tokens)", async () => {
    const out = await run(
      event("openai", {
        id: "chatcmpl_1",
        usage: { prompt_tokens: 4, completion_tokens: 8, total_tokens: 12 },
      })
    );
    assert.deepEqual(out.tokens, {
      inputTokens: 4,
      outputTokens: 8,
      totalTokens: 12,
    });
  });

  test("Gemini usageMetadata", async () => {
    const out = await run(
      event("gemini", {
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 11 },
      })
    );
    assert.deepEqual(out.tokens, {
      inputTokens: 5,
      outputTokens: 11,
      totalTokens: 16,
    });
  });

  test("response without usage → tokens: null", async () => {
    const out = await run(event("anthropic", { id: "msg_1" }));
    assert.equal(out.tokens, null);
  });

  test("unknown provider → tokens: null", async () => {
    const out = await run(
      event("unknown", { usage: { input_tokens: 1, output_tokens: 2 } })
    );
    assert.equal(out.tokens, null);
  });

  test("non-object response → tokens: null", async () => {
    const out = await run(event("anthropic", "data: ...\n\n"));
    assert.equal(out.tokens, null);
  });

  test("falls back to input + output when total is missing", async () => {
    const out = await run(
      event("openai", { usage: { input_tokens: 3, output_tokens: 4 } })
    );
    assert.equal(out.tokens?.totalTokens, 7);
  });

  test("preserves existing event fields", async () => {
    const e = event("anthropic", { usage: { input_tokens: 1, output_tokens: 2 } });
    const out = await run(e);
    assert.equal(out.schemaVersion, e.schemaVersion);
    assert.equal(out.endpoint, e.endpoint);
    assert.equal(out.provider, e.provider);
  });
});
