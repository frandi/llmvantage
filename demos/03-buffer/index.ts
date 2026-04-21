/**
 * Demo 03 — Buffered batch delivery + graceful drain.
 *
 * Fires a burst of Anthropic calls and watches them arrive in the observer
 * pipeline individually, but leave it in batches via `createBuffer`. The
 * drain handler is where you'd pipeline a collector (HTTP, Redis, S3, etc.)
 * — see Pattern B in packages/llmvantage/src/sinks/README.md.
 */
import "dotenv/config";
import "llmvantage";
import { observer, createBuffer, type LLMEvent } from "llmvantage";
import {
  normalizeTokens,
  type EventWithTokens,
} from "llmvantage/plugins/normalize-tokens";
import Anthropic from "@anthropic-ai/sdk";

// --- Buffer: collects post-plugin events, flushes in batches of up to 3. ----
let batchNo = 0;
const buf = createBuffer(
  async (batch: LLMEvent[]) => {
    batchNo++;
    const totalTokens = batch.reduce(
      (n, e) => n + ((e as EventWithTokens).tokens?.totalTokens ?? 0),
      0
    );
    console.log(
      `[buffer] batch #${batchNo}: ${batch.length} events, ${totalTokens} total tokens, endpoints=${batch
        .map((e) => e.endpoint)
        .join(",")}`
    );

    // ── In a real app, this is where you'd ship the batch to a collector:
    //    await fetch("https://collector.internal/events", {
    //      method: "POST",
    //      headers: { "content-type": "application/json" },
    //      body: JSON.stringify({ events: batch }),
    //    });
  },
  {
    flushInterval: 200, // tick every 200 ms
    batchSize:     3,   // up to 3 events per handler call
    maxQueueSize:  1000,
    dropPolicy:    "oldest",
    onDrop:  (e) => console.warn(`[buffer] dropped event for ${e.endpoint}`),
    onError: (err, b) =>
      console.error(`[buffer] handler failed for batch of ${b.length}:`, err.message),
  }
);

observer
  .use(normalizeTokens)   // populate event.tokens for the handler to sum
  .pipe(buf.enqueue)      // buf.enqueue *is* a Sink — no adapter needed
  .onError((err) => console.warn("[llmvantage]", err.phase, err.error.message));

// --- Burst: fire 5 cheap Anthropic calls concurrently. ---------------------
const client = new Anthropic();

const ask = (i: number) =>
  client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 32,
    messages: [{ role: "user", content: `Say "buffered ${i}" in one word.` }],
  });

console.log("[app] firing burst of 5 concurrent calls...");
const t0 = performance.now();
const results = await Promise.all([ask(1), ask(2), ask(3), ask(4), ask(5)]);
console.log(
  `[app] burst completed in ${(performance.now() - t0).toFixed(0)} ms — ${results.length} responses`
);

// --- Graceful drain: await any still-queued batches before exiting. --------
// Without this, `beforeExit` would drain the buffer *fire-and-forget* — fine
// for production, but a demo that exits immediately wouldn't show the last
// batch. Explicit flush also gives you a deterministic end-of-work signal.
console.log(`[app] flushing buffer (depth=${buf.depth})...`);
await buf.flush();
console.log("[app] done — all events delivered.");
