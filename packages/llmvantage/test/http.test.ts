import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { observer, __internal } from "../src/core.js";
import { httpSink } from "../src/sinks/http.js";
import type { LLMEvent, ObserverError, Provider } from "../src/types.js";

const URL = "https://collector.internal/events";

const event = (overrides: Partial<LLMEvent> = {}): LLMEvent => ({
  schemaVersion: "1.0",
  provider: "anthropic" as Provider,
  endpoint: "/v1/messages",
  request: { model: "claude-sonnet-4-5" },
  response: { id: "msg_1" },
  latencyMs: 42,
  timestamp: "2026-04-21T00:00:00.000Z",
  streaming: false,
  ...overrides,
});

const nextTick = () => new Promise((r) => setImmediate(r));

describe("httpSink", () => {
  beforeEach(() => __internal.reset());

  test("POSTs JSON body with default content-type to the given URL", async () => {
    let seenUrl: string | URL | Request | undefined;
    let seenInit: RequestInit | undefined;
    __internal.setOriginalFetch(async (url, init) => {
      seenUrl = url as string;
      seenInit = init;
      return new Response(null, { status: 204 });
    });

    observer.pipe(httpSink(URL));
    const e = event();
    await __internal.runPipeline(e);

    assert.equal(seenUrl, URL);
    assert.equal(seenInit?.method, "POST");
    const headers = new Headers(seenInit?.headers);
    assert.equal(headers.get("content-type"), "application/json");
    assert.ok(typeof seenInit?.body === "string");
    assert.deepEqual(JSON.parse(seenInit!.body as string), e);
  });

  test("merges custom headers and allows overriding content-type", async () => {
    let seenInit: RequestInit | undefined;
    __internal.setOriginalFetch(async (_url, init) => {
      seenInit = init;
      return new Response(null, { status: 200 });
    });

    observer.pipe(
      httpSink(URL, {
        authorization: "Bearer secret",
        "content-type": "application/vnd.llm+json",
      })
    );
    await __internal.runPipeline(event());

    const headers = new Headers(seenInit?.headers);
    assert.equal(headers.get("authorization"), "Bearer secret");
    assert.equal(headers.get("content-type"), "application/vnd.llm+json");
  });

  test("non-2xx response routes to onError with phase=sink", async () => {
    __internal.setOriginalFetch(
      async () => new Response("nope", { status: 500, statusText: "Boom" })
    );

    const errors: ObserverError[] = [];
    observer
      .pipe(httpSink(URL))
      .onError((err) => errors.push(err));

    await __internal.runPipeline(event());

    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.phase, "sink");
    assert.match(errors[0]!.error.message, /500/);
  });

  test("rejected fetch (network error) routes to onError", async () => {
    __internal.setOriginalFetch(async () => {
      throw new Error("ECONNREFUSED");
    });

    const errors: ObserverError[] = [];
    observer
      .pipe(httpSink(URL))
      .onError((err) => errors.push(err));

    await __internal.runPipeline(event());

    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.phase, "sink");
    assert.match(errors[0]!.error.message, /ECONNREFUSED/);
  });

  test("uses the unpatched fetch — no re-entry into the fetch patch", async () => {
    // If httpSink were using globalThis.fetch (the patched version), a POST
    // to an LLM host would spin the pipeline again. Stub originalFetch with
    // a counter so we can prove only one call happens.
    let originalCalls = 0;
    __internal.setOriginalFetch(async () => {
      originalCalls++;
      return new Response(null, { status: 204 });
    });

    // Use an LLM host URL on purpose — the patched fetch would intercept this
    // and enqueue another pipeline run. The sink must bypass it.
    const LLM_COLLECTOR = "https://api.anthropic.com/internal-audit";

    let pipelineRuns = 0;
    observer.pipe(httpSink(LLM_COLLECTOR));
    observer.pipe(() => {
      pipelineRuns++;
    });

    await __internal.runPipeline(event());
    // Let any stray setImmediate-scheduled captures fire.
    await nextTick();
    await nextTick();

    assert.equal(originalCalls, 1);
    assert.equal(pipelineRuns, 1);
  });
});
