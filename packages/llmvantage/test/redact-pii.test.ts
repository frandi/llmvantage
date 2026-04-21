import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  PII_PATTERNS,
  redactPii,
  type PiiPattern,
} from "../src/plugins/redact-pii.js";
import type { LLMEvent, Provider } from "../src/types.js";

const event = (
  request: unknown,
  response: unknown,
  provider: Provider = "anthropic"
): LLMEvent => ({
  schemaVersion: "1.0",
  provider,
  endpoint: "/v1/messages",
  request,
  response,
  latencyMs: 42,
  timestamp: "2026-04-21T00:00:00.000Z",
  streaming: false,
});

const run = async (e: LLMEvent): Promise<LLMEvent> => {
  const out = await redactPii(e);
  return out;
};

describe("redactPii — patterns", () => {
  test("email inside nested messages.content is replaced", async () => {
    const out = await run(
      event(
        {
          model: "claude-sonnet-4-5",
          messages: [
            { role: "user", content: "my email is alice@example.com please" },
          ],
        },
        { id: "msg_1" }
      )
    );
    const msg = (out.request as any).messages[0].content;
    assert.equal(msg, "my email is [EMAIL] please");
  });

  test("US phone formats are replaced", async () => {
    for (const phone of [
      "(555) 555-5555",
      "555-555-5555",
      "+1 555 555 5555",
      "5555555555",
    ]) {
      const out = await run(event({ note: `call ${phone} now` }, null));
      assert.equal(
        (out.request as any).note,
        "call [PHONE] now",
        `failed for: ${phone}`
      );
    }
  });

  test("OpenAI sk-proj and Anthropic sk-ant API keys are replaced", async () => {
    const openaiKey = "sk-proj-" + "a".repeat(40);
    const anthropicKey = "sk-ant-api03-" + "b".repeat(80);
    const out = await run(
      event(
        { system: `use ${openaiKey} and also ${anthropicKey}` },
        null
      )
    );
    const system = (out.request as any).system;
    assert.ok(system.includes("[API_KEY]"));
    assert.ok(!system.includes(openaiKey));
    assert.ok(!system.includes(anthropicKey));
    // Two distinct matches
    assert.equal(system.match(/\[API_KEY\]/g)?.length, 2);
  });

  test("short sk- strings are not false-matched", async () => {
    const out = await run(event({ note: "sk-short" }, null));
    assert.equal((out.request as any).note, "sk-short");
  });

  test("multiple patterns in one string are all replaced", async () => {
    const out = await run(
      event(
        {
          content: "email bob@x.io or call 555-555-5555",
        },
        null
      )
    );
    assert.equal(
      (out.request as any).content,
      "email [EMAIL] or call [PHONE]"
    );
  });

  test("streaming SSE string response is redacted", async () => {
    const key = "sk-" + "z".repeat(30);
    const sse = `data: {"text":"your key is ${key}"}\n\ndata: [DONE]\n\n`;
    const out = await run(event({}, sse));
    assert.ok(typeof out.response === "string");
    assert.ok(!(out.response as string).includes(key));
    assert.ok((out.response as string).includes("[API_KEY]"));
  });
});

describe("redactPii — tree walker", () => {
  test("undefined request and response pass through", async () => {
    const out = await run(event(undefined, undefined));
    assert.equal(out.request, undefined);
    assert.equal(out.response, undefined);
  });

  test("non-string primitives are preserved exactly", async () => {
    const req = {
      temperature: 0.7,
      streaming: true,
      maxTokens: null as null | number,
      big: 9007199254740993n,
    };
    const out = await run(event(req, null));
    const r = out.request as typeof req;
    assert.equal(r.temperature, 0.7);
    assert.equal(r.streaming, true);
    assert.equal(r.maxTokens, null);
    assert.equal(r.big, 9007199254740993n);
  });

  test("structural sharing: unchanged request returns same reference", async () => {
    const req = {
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "hello world, no PII here" }],
    };
    const out = await run(event(req, null));
    assert.equal(out.request, req);
    assert.equal((out.request as any).messages, req.messages);
    assert.equal((out.request as any).messages[0], req.messages[0]);
  });

  test("structural sharing: only mutated branches are reallocated", async () => {
    const clean = { role: "system", content: "no secrets here" };
    const dirty = { role: "user", content: "my email is eve@example.com" };
    const req = { messages: [clean, dirty] };
    const out = await run(event(req, null));
    const outMsgs = (out.request as any).messages as typeof req.messages;
    // Root changed because a descendant changed.
    assert.notEqual(out.request, req);
    assert.notEqual(outMsgs, req.messages);
    // Clean branch preserved by identity.
    assert.equal(outMsgs[0], clean);
    // Dirty branch replaced.
    assert.notEqual(outMsgs[1], dirty);
    assert.equal((outMsgs[1] as any).content, "my email is [EMAIL]");
  });
});

describe("redactPii — extensibility", () => {
  let added: PiiPattern | null = null;

  afterEach(() => {
    if (added) {
      const idx = PII_PATTERNS.indexOf(added);
      if (idx >= 0) PII_PATTERNS.splice(idx, 1);
      added = null;
    }
  });

  test("custom pattern pushed into PII_PATTERNS is applied", async () => {
    added = {
      pattern: /\bBADGE-\d{6}\b/g,
      replacement: "[BADGE]",
    };
    PII_PATTERNS.push(added);
    const out = await run(event({ who: "user BADGE-123456 signed in" }, null));
    assert.equal((out.request as any).who, "user [BADGE] signed in");
  });
});

describe("redactPii — event identity", () => {
  test("preserves unrelated event fields", async () => {
    const e = event(
      { messages: [{ role: "user", content: "alice@example.com" }] },
      { id: "msg_1" },
      "openai"
    );
    const out = await run(e);
    assert.equal(out.schemaVersion, "1.0");
    assert.equal(out.provider, "openai");
    assert.equal(out.endpoint, "/v1/messages");
    assert.equal(out.latencyMs, 42);
    assert.equal(out.timestamp, "2026-04-21T00:00:00.000Z");
    assert.equal(out.streaming, false);
  });
});
