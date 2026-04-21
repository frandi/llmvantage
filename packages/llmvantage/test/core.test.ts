import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { observer, __internal } from "../src/core.js";
import type { LLMEvent } from "../src/types.js";

const LLM_URL = "https://api.anthropic.com/v1/messages";
const NON_LLM_URL = "https://example.com/other";

const baseEvent = (): LLMEvent => ({
  schemaVersion: "1.0",
  provider: "anthropic",
  endpoint: "/v1/messages",
  request: { model: "claude" },
  response: { id: "msg_1" },
  latencyMs: 12,
  timestamp: new Date().toISOString(),
  streaming: false,
});

const nextTick = () => new Promise((r) => setImmediate(r));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("observer registration", () => {
  beforeEach(() => __internal.reset());

  test("use() after pipe() throws", () => {
    observer.use((e) => e);
    observer.pipe(() => {});
    assert.throws(
      () => observer.use((e) => e),
      /Plugins must be registered before sinks/
    );
  });

  test("use() before any pipe() is allowed", () => {
    assert.doesNotThrow(() => {
      observer.use((e) => e).use((e) => e);
    });
  });

  test("chained registration returns observer", () => {
    const r = observer
      .use((e) => e)
      .pipe(() => {})
      .onError(() => {});
    assert.equal(r, observer);
  });
});

describe("pipeline", () => {
  beforeEach(() => __internal.reset());

  test("plugins run in order and output feeds the next plugin", async () => {
    const steps: string[] = [];
    observer
      .use((e) => {
        steps.push("a");
        return { ...e, _marker: "a" } as LLMEvent;
      })
      .use((e) => {
        steps.push(`b-saw-${(e as any)._marker}`);
        return e;
      })
      .pipe((e) => {
        steps.push(`sink-${(e as any)._marker}`);
      });

    await __internal.runPipeline(baseEvent());
    assert.deepEqual(steps, ["a", "b-saw-a", "sink-a"]);
  });

  test("all sinks receive the same post-plugin event", async () => {
    const seen: LLMEvent[] = [];
    observer
      .use((e) => ({ ...e, endpoint: "/rewritten" }))
      .pipe((e) => { seen.push(e); })
      .pipe((e) => { seen.push(e); });

    await __internal.runPipeline(baseEvent());
    assert.equal(seen.length, 2);
    assert.equal(seen[0]!.endpoint, "/rewritten");
    assert.equal(seen[1]!.endpoint, "/rewritten");
  });

  test("plugin throw routes to onError and halts the pipeline", async () => {
    const errors: string[] = [];
    let sinkCalled = false;
    observer
      .use(() => { throw new Error("boom"); })
      .pipe(() => { sinkCalled = true; })
      .onError((err) => { errors.push(err.phase); });

    await __internal.runPipeline(baseEvent());
    assert.deepEqual(errors, ["plugin"]);
    assert.equal(sinkCalled, false);
  });

  test("sink throw routes to onError without affecting other sinks", async () => {
    const errors: string[] = [];
    let sinkBCalled = false;
    observer
      .pipe(() => { throw new Error("sink-a failed"); })
      .pipe(() => { sinkBCalled = true; })
      .onError((err) => { errors.push(err.phase); });

    await __internal.runPipeline(baseEvent());
    assert.equal(sinkBCalled, true);
    assert.deepEqual(errors, ["sink"]);
  });

  test("errors are swallowed silently when no handler is registered", async () => {
    observer.use(() => { throw new Error("boom"); }).pipe(() => {});
    await assert.doesNotReject(() => __internal.runPipeline(baseEvent()));
  });
});

describe("fetch patch", () => {
  beforeEach(() => __internal.reset());

  test("non-LLM URLs pass through to original fetch without pipeline activity", async () => {
    let originalCalled = false;
    __internal.setOriginalFetch(async () => {
      originalCalled = true;
      return new Response("ok", { status: 200 });
    });
    let pipelineEvents = 0;
    observer.pipe(() => { pipelineEvents++; });

    const res = await globalThis.fetch(NON_LLM_URL);
    assert.equal(originalCalled, true);
    assert.equal(res.status, 200);

    await nextTick();
    assert.equal(pipelineEvents, 0);
  });

  test("LLM URL produces an event with parsed request and response bodies", async () => {
    __internal.setOriginalFetch(async () =>
      new Response(
        JSON.stringify({ id: "msg_1", usage: { input_tokens: 3 } }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const captured: LLMEvent[] = [];
    observer.pipe((e) => { captured.push(e); });

    const body = JSON.stringify({
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "hi" }],
    });
    const res = await globalThis.fetch(LLM_URL, { method: "POST", body });

    // SDK copy must still be readable — the tee() must not have drained it.
    const sdkCopy = await res.text();
    assert.ok(sdkCopy.includes("msg_1"));

    await wait(20);

    assert.equal(captured.length, 1);
    const evt = captured[0]!;
    assert.equal(evt.provider, "anthropic");
    assert.equal(evt.endpoint, "/v1/messages");
    assert.equal((evt.request as any).model, "claude-sonnet-4-5");
    assert.equal((evt.response as any).id, "msg_1");
    assert.equal(evt.streaming, false);
    assert.equal(evt.schemaVersion, "1.0");
    assert.equal(typeof evt.latencyMs, "number");
  });

  test("streaming responses are tee'd — SDK copy readable, observer sees raw text", async () => {
    const sseBody = 'data: {"id":"msg_2"}\n\ndata: [DONE]\n\n';
    __internal.setOriginalFetch(async () =>
      new Response(sseBody, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })
    );

    const captured: LLMEvent[] = [];
    observer.pipe((e) => { captured.push(e); });

    const res = await globalThis.fetch(LLM_URL, { method: "POST", body: "{}" });
    const sdkText = await res.text();
    assert.equal(sdkText, sseBody);

    await wait(20);
    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.streaming, true);
    assert.equal(captured[0]!.response, sseBody);
  });
});
