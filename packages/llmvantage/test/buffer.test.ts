import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createBuffer, __internal as bufInternal } from "../src/buffer.js";
import { observer, __internal as coreInternal } from "../src/core.js";
import type { LLMEvent, Provider, Sink } from "../src/types.js";

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

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  coreInternal.reset();
  bufInternal.reset();
});

afterEach(() => {
  bufInternal.reset();
});

describe("createBuffer — enqueue & depth", () => {
  test("enqueue stores events; depth reflects count", () => {
    const buf = createBuffer(async () => {}, {
      handleSignals: false,
      flushInterval: 10_000,
    });
    assert.equal(buf.depth, 0);
    buf.enqueue(event());
    buf.enqueue(event());
    buf.enqueue(event());
    assert.equal(buf.depth, 3);
  });
});

describe("createBuffer — interval-driven drain", () => {
  test("interval drain fires handler with up to batchSize events", async () => {
    const batches: LLMEvent[][] = [];
    const buf = createBuffer(
      async (batch) => {
        batches.push(batch);
      },
      { handleSignals: false, flushInterval: 10, batchSize: 5 }
    );

    for (let i = 0; i < 3; i++) buf.enqueue(event({ latencyMs: i }));
    await wait(30);

    assert.equal(batches.length, 1);
    assert.equal(batches[0]!.length, 3);
    assert.equal(buf.depth, 0);
    await buf.flush();
  });

  test("queue > batchSize drains across successive ticks (one batch per tick)", async () => {
    const batches: LLMEvent[][] = [];
    const buf = createBuffer(
      async (batch) => {
        batches.push(batch);
      },
      { handleSignals: false, flushInterval: 10, batchSize: 3 }
    );

    for (let i = 0; i < 7; i++) buf.enqueue(event({ latencyMs: i }));
    // Needs 3 ticks to drain 7 at batchSize=3 (3 + 3 + 1).
    await wait(80);

    assert.equal(buf.depth, 0);
    const totalDelivered = batches.reduce((n, b) => n + b.length, 0);
    assert.equal(totalDelivered, 7);
    assert.ok(batches.length >= 3, `expected ≥3 batches, got ${batches.length}`);
    assert.ok(batches.every((b) => b.length <= 3));
    await buf.flush();
  });
});

describe("createBuffer — flush()", () => {
  test("drains remaining events and stops the timer", async () => {
    let batches = 0;
    const buf = createBuffer(
      async () => {
        batches++;
      },
      { handleSignals: false, flushInterval: 10, batchSize: 2 }
    );

    buf.enqueue(event());
    buf.enqueue(event());
    buf.enqueue(event());
    await buf.flush();
    assert.equal(buf.depth, 0);

    const batchesAfterFlush = batches;
    // Wait long enough for the interval (if it were still alive) to fire.
    await wait(50);
    assert.equal(batches, batchesAfterFlush, "interval should be stopped after flush");
  });

  test("concurrent flush() calls share the in-flight drain", async () => {
    let handlerCalls = 0;
    const buf = createBuffer(
      async () => {
        handlerCalls++;
        await wait(20);
      },
      { handleSignals: false, flushInterval: 10_000, batchSize: 2 }
    );

    buf.enqueue(event());
    buf.enqueue(event());
    buf.enqueue(event());
    buf.enqueue(event());

    const [r1, r2] = await Promise.all([buf.flush(), buf.flush()]);
    assert.equal(r1, undefined);
    assert.equal(r2, undefined);
    assert.equal(buf.depth, 0);
    // 4 events at batchSize=2 → exactly 2 handler calls, not 4.
    assert.equal(handlerCalls, 2);
  });

  test("second flush after new enqueues works", async () => {
    const batches: LLMEvent[][] = [];
    const buf = createBuffer(
      async (b) => {
        batches.push(b);
      },
      { handleSignals: false, flushInterval: 10_000, batchSize: 10 }
    );

    buf.enqueue(event({ endpoint: "/A" }));
    await buf.flush();
    buf.enqueue(event({ endpoint: "/B" }));
    await buf.flush();

    assert.equal(batches.length, 2);
    assert.equal(batches[0]![0]!.endpoint, "/A");
    assert.equal(batches[1]![0]!.endpoint, "/B");
  });
});

describe("createBuffer — drop policies", () => {
  test("dropPolicy 'oldest' shifts head and fires onDrop with shifted event", () => {
    const dropped: LLMEvent[] = [];
    const buf = createBuffer(async () => {}, {
      handleSignals: false,
      flushInterval: 10_000,
      maxQueueSize: 2,
      dropPolicy: "oldest",
      onDrop: (e) => dropped.push(e),
    });

    buf.enqueue(event({ endpoint: "/first" }));
    buf.enqueue(event({ endpoint: "/second" }));
    buf.enqueue(event({ endpoint: "/third" }));

    assert.equal(buf.depth, 2);
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0]!.endpoint, "/first");
  });

  test("dropPolicy 'newest' rejects incoming event; queue unchanged", () => {
    const dropped: LLMEvent[] = [];
    const buf = createBuffer(async () => {}, {
      handleSignals: false,
      flushInterval: 10_000,
      maxQueueSize: 2,
      dropPolicy: "newest",
      onDrop: (e) => dropped.push(e),
    });

    buf.enqueue(event({ endpoint: "/first" }));
    buf.enqueue(event({ endpoint: "/second" }));
    buf.enqueue(event({ endpoint: "/third" }));

    assert.equal(buf.depth, 2);
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0]!.endpoint, "/third");
  });
});

describe("createBuffer — error handling", () => {
  test("handler throw routes to onError; drain loop survives", async () => {
    const errors: Error[] = [];
    const batches: LLMEvent[][] = [];
    let call = 0;
    const buf = createBuffer(
      async (batch) => {
        call++;
        if (call === 1) throw new Error("first batch fails");
        batches.push(batch);
      },
      {
        handleSignals: false,
        flushInterval: 10,
        batchSize: 2,
        onError: (err) => errors.push(err),
      }
    );

    buf.enqueue(event({ endpoint: "/a" }));
    buf.enqueue(event({ endpoint: "/b" }));
    buf.enqueue(event({ endpoint: "/c" }));
    buf.enqueue(event({ endpoint: "/d" }));

    await wait(60);
    await buf.flush();

    assert.equal(errors.length, 1);
    assert.match(errors[0]!.message, /first batch fails/);
    // Second batch must still have been delivered.
    assert.ok(batches.length >= 1);
    const endpoints = batches.flat().map((e) => e.endpoint);
    assert.ok(endpoints.includes("/c") && endpoints.includes("/d"));
  });
});

describe("createBuffer — shutdown signals", () => {
  test("handleSignals: false leaves process listener counts unchanged", () => {
    const before = {
      beforeExit: process.listenerCount("beforeExit"),
      sigterm: process.listenerCount("SIGTERM"),
    };
    createBuffer(async () => {}, { handleSignals: false, flushInterval: 10_000 });
    createBuffer(async () => {}, { handleSignals: false, flushInterval: 10_000 });

    assert.equal(process.listenerCount("beforeExit"), before.beforeExit);
    assert.equal(process.listenerCount("SIGTERM"), before.sigterm);
  });

  test("handleSignals: true registers exactly one listener pair across many buffers", () => {
    const before = {
      beforeExit: process.listenerCount("beforeExit"),
      sigterm: process.listenerCount("SIGTERM"),
    };

    createBuffer(async () => {}, { handleSignals: true, flushInterval: 10_000 });
    createBuffer(async () => {}, { handleSignals: true, flushInterval: 10_000 });

    assert.equal(
      process.listenerCount("beforeExit") - before.beforeExit,
      1,
      "beforeExit should gain exactly 1 listener regardless of buffer count"
    );
    assert.equal(
      process.listenerCount("SIGTERM") - before.sigterm,
      1,
      "SIGTERM should gain exactly 1 listener regardless of buffer count"
    );
  });

  test("beforeExit handler drains all active buffers", async () => {
    let drained1 = 0;
    let drained2 = 0;
    const buf1 = createBuffer(
      async (b) => {
        drained1 += b.length;
      },
      { handleSignals: true, flushInterval: 10_000, batchSize: 100 }
    );
    const buf2 = createBuffer(
      async (b) => {
        drained2 += b.length;
      },
      { handleSignals: true, flushInterval: 10_000, batchSize: 100 }
    );

    buf1.enqueue(event());
    buf1.enqueue(event());
    buf2.enqueue(event());

    // Invoke the registered beforeExit listener directly — emitting the real
    // event inside node:test destabilises the runner (it sees "beforeExit" as
    // a signal that the event loop has drained). Calling the listener is
    // equivalent: it fires `void drainAll()` which sets each buffer's
    // flushPromise synchronously, so the subsequent `buf.flush()` calls
    // return the same in-flight promise we await here.
    const listeners = process.listeners("beforeExit");
    const ours = listeners[listeners.length - 1] as (code?: number) => void;
    ours(0);
    await Promise.all([buf1.flush(), buf2.flush()]);

    assert.equal(buf1.depth, 0);
    assert.equal(buf2.depth, 0);
    assert.equal(drained1, 2);
    assert.equal(drained2, 1);
  });
});

describe("createBuffer — observer integration", () => {
  test("enqueue typechecks and functions as a Sink", async () => {
    const batches: LLMEvent[][] = [];
    const buf = createBuffer(
      async (b) => {
        batches.push(b);
      },
      { handleSignals: false, flushInterval: 10_000, batchSize: 10 }
    );

    // Compile-time check: enqueue must satisfy the Sink signature.
    const asSink: Sink = buf.enqueue;
    observer.pipe(asSink);

    await coreInternal.runPipeline(event({ endpoint: "/observed" }));
    assert.equal(buf.depth, 1);

    await buf.flush();
    assert.equal(batches.length, 1);
    assert.equal(batches[0]![0]!.endpoint, "/observed");
  });
});
