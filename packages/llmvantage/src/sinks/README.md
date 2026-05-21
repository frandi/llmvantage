# Sinks

A sink is a function `(event: LLMEvent) => void | Promise<void>`. All registered sinks receive the same final event after every plugin has run, so **sinks can assume the data is already compliant** — they never need to re-implement redaction, filtering, or policy checks.

See [../../../../docs/llmvantage-spec.md](../../../../docs/llmvantage-spec.md) §7 for the full contract.

## Event shape (schema 1.1)

Every event carries a `source: "fetch" | "manual"` discriminator: `"fetch"` for events captured by the fetch patch, `"manual"` for events pushed via `observer.ingest()`. Sinks see both — filter on `source` if a downstream collector should only receive one or the other:

```typescript
const fetchOnly: Sink = (event) => {
  if (event.source !== 'fetch') return;
  // ...
};
```

`httpSink`, `fileSink`, and `consoleSink` all serialize `source` as-is, so the field appears verbatim on the wire / in the NDJSON file. If you operate a strict-schema collector, allow the new field before upgrading.

## Registration

Sinks are registered with `observer.pipe()`, **after** all compliance plugins. Multiple sinks receive the same event concurrently.

```typescript
import { observer } from 'llmvantage';
import { redactPii }   from 'llmvantage/plugins/redact-pii';
import { fileSink }    from 'llmvantage/sinks/ndjson-file';
import { httpSink }    from 'llmvantage/sinks/http';
import { consoleSink } from 'llmvantage/sinks/console';

observer
  .use(redactPii)
  .pipe(fileSink('./llm-calls.ndjson'))
  .pipe(httpSink('https://collector.internal/events'))
  .pipe(consoleSink);
```

## Bundled sinks

| Sink | Path | Durability | Best for |
|---|---|---|---|
| `consoleSink` | `llmvantage/sinks/console` | none | Development, local inspection |
| `fileSink(path)` | `llmvantage/sinks/ndjson-file` | best-effort | Single-instance local audit log |
| `httpSink(url, headers?)` | `llmvantage/sinks/http` | none (no retry) | POST to a collector; pair with `buffer` or a retry wrapper |

---

### `consoleSink`

Writes a compact one-line JSON summary (`t`, `provider`, `endpoint`, `latencyMs`, `streaming`, and `tokens` when `normalizeTokens` has run) to stdout. Intended for development only.

---

### `fileSink(path)`

Opens a persistent append-mode `fs.WriteStream` the first time the factory is called, and appends `JSON.stringify(event) + '\n'` per event (NDJSON).

**Why a persistent stream:** one file descriptor per registration instead of `open + write + close` per event — eliminates ~30–100× of syscall overhead and lets Node's internal 16 KB buffer coalesce small writes into fewer kernel writes. The internal queue also serialises concurrent writes, so events larger than `PIPE_BUF` (4 KB) never interleave.

**Graceful drain:** `beforeExit` is registered once, globally — when the event loop drains naturally the sink calls `stream.end()` on all active streams. `SIGTERM` is deliberately **not** handled here (it belongs to a buffer layer); `process.exit(N)` also skips `beforeExit`. Under abrupt termination, up to ~16 KB of Node-userspace-buffered writes may be lost. This is the cost of the performance win over `appendFileSync`.

**Error handling:** a single `stream.on('error')` listener logs to stderr. Async write errors can't route to `observer.onError` because the sink's synchronous call has already returned.

**Test-only helper:** the module exports `__internal.drainAll()` so tests can flush + close all active streams deterministically before reading the file.

---

### `httpSink(url, headers?)`

POSTs each event as `application/json` to `url`, using the **unpatched** fetch so the sink's own traffic is never captured by the observer.

- Non-2xx responses throw → routed to `observer.onError` with `phase: "sink"`.
- Network rejections throw → same path.
- Response body is never read (socket free to close).
- No timeout, no retry, no batching — compose on top (see below).

```typescript
observer.pipe(httpSink('https://collector.internal/events', {
  authorization: `Bearer ${process.env.COLLECTOR_TOKEN}`,
}));
```

---

## Composition patterns

The `Sink` signature is intentionally minimal — there's no lifecycle, no config surface, no framework. Every cross-cutting concern is added by **wrapping**. Five doors cover nearly every need:

### 1. Wrap an existing sink (retry, timeout, rate-limit)

```typescript
import { httpSink } from 'llmvantage/sinks/http';
import type { Sink, LLMEvent } from 'llmvantage';

const retrying = (inner: Sink, max = 3): Sink =>
  async (event: LLMEvent) => {
    for (let i = 0; i < max; i++) {
      try { await inner(event); return; }
      catch (err) {
        if (i === max - 1) throw err;
        await new Promise(r => setTimeout(r, 2 ** i * 100));
      }
    }
  };

const withTimeout = (inner: Sink, ms: number): Sink =>
  (event) => Promise.race([
    Promise.resolve(inner(event)),
    new Promise<void>((_, rej) =>
      setTimeout(() => rej(new Error('sink timeout')), ms)
    ),
  ]);

observer.pipe(
  withTimeout(retrying(httpSink('https://collector.internal/events')), 2000)
);
```

### 2. Write a standalone sink

Any function matching the signature is a valid sink — S3, Kafka, Datadog, Sentry, Postgres, Slack webhook, etc.

```typescript
import type { Sink } from 'llmvantage';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({});
export const s3Sink = (bucket: string): Sink =>
  async (event) => {
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: `llm/${event.timestamp}-${crypto.randomUUID()}.json`,
      Body: JSON.stringify(event),
    }));
  };
```

### 3. Fan out to multiple destinations

Built in — call `.pipe()` multiple times. Each sink receives the same post-plugin event; they run concurrently.

```typescript
observer
  .pipe(fileSink('./local.ndjson'))
  .pipe(httpSink('https://collector.internal/events'))
  .pipe(s3Sink('my-llm-logs'));
```

### 4. File rotation / compression / partitioning

Wrap `fileSink` with your own path resolver:

```typescript
const rotatingFileSink = (dir: string): Sink => {
  let current: Sink | null = null;
  let currentDate = '';
  return (event) => {
    const date = new Date().toISOString().slice(0, 10);
    if (date !== currentDate) {
      current = fileSink(`${dir}/${date}.ndjson`);
      currentDate = date;
    }
    current!(event);
  };
};
```

Gzip: same shape, but your sink owns a `createGzip()` piped into `createWriteStream('events.ndjson.gz')`.

### 5. Conditional emit (usually belongs in a plugin)

"Only log slow calls" / "only log errors" is *usually* a plugin concern (plugins can mutate or skip work upstream). But a sink-level filter works too:

```typescript
const onlySlow = (inner: Sink, thresholdMs: number): Sink =>
  (event) => event.latencyMs >= thresholdMs ? inner(event) : undefined;
```

---

## Batching & graceful drain (`llmvantage/buffer`)

Fire-per-event is fine for development and low-QPS apps, but collapses under production load: one TCP round-trip per event for `httpSink`, up to ~16 KB of userspace writes lost on abrupt exit for `fileSink`, zero resilience to transient collector stalls. `createBuffer` introduces an in-memory bounded queue + interval-flushed batching primitive that decouples the pipeline from delivery.

```typescript
import { observer, createBuffer } from 'llmvantage';
import { httpSink } from 'llmvantage/sinks/http';
```

### Pattern A — batch delivery to a collector

Deliver N events per HTTP POST instead of N round-trips. The handler owns the wire format:

```typescript
const buf = createBuffer(
  async (batch) => {
    const res = await fetch('https://collector.internal/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: batch }),
    });
    if (!res.ok) throw new Error(`collector ${res.status}`);
  },
  {
    flushInterval: 500,         // ms between drain ticks
    batchSize:     50,
    maxQueueSize:  10_000,
    dropPolicy:    'oldest',    // keep the freshest events under stall
    onError: (err, batch) => app.metrics.increment('llm.batch.failed', batch.length),
    onDrop:  ()           => app.metrics.increment('llm.event.dropped'),
  }
);

observer.pipe(buf.enqueue);     // enqueue matches the Sink signature exactly
```

### Pattern B — time-decouple an existing sink

Wrap any existing sink so it receives one batch-worth of events per tick instead of per event. The adapter is three lines:

```typescript
const inner = httpSink('https://collector.internal/events');
const buf = createBuffer(async (batch) => {
  for (const e of batch) await inner(e);   // or: await Promise.all(batch.map(inner))
});
observer.pipe(buf.enqueue);
```

Use sequential `for…await` for strict ordering; use `Promise.all` when the inner sink's writes are commutative (e.g. S3, Kafka).

### Shutdown

`handleSignals: true` (the default) joins the buffer to a **single** process-wide `beforeExit` + `SIGTERM` pair that drains every active buffer before exit. Multiple buffers share the one handler — no races between buffers racing `process.exit()`.

- `beforeExit` — buffers drain naturally when the event loop empties.
- `SIGTERM` — all buffers drain, then `process.exit(0)`.
- `handleSignals: false` — you own drain via explicit `await buf.flush()` before exit.

`flush()` is concurrent-safe and idempotent: two callers share the same in-flight drain promise.

### Drop policy

`"oldest"` (default) is the telemetry-appropriate choice — during a collector stall the most recent events are more actionable than ones that arrived 30 s ago. `"newest"` (tail drop) is better for work queues where already-accepted work must be honored.

FIFO order is preserved under `"newest"` (the queue is a strict tail). Under `"oldest"` the head is shifted, so strict FIFO across the whole event history is not guaranteed — but batch-internal order is always preserved.

### Cost & tradeoffs

- **Backpressure** is not signaled back to the observer pipeline in v1. `onDrop` is the feedback mechanism — wire it to your metrics.
- `Array.prototype.shift()` is O(n); only incurred under sustained `"oldest"` overload. A ring-buffer optimisation is deferred until benchmarks justify it.
- One batch per interval tick — never blocks the event loop during bursts.

---

## Why composition, not configuration

Sinks are pure leaf functions. All configuration lives in factory closures. All cross-cutting concerns (retry, timeout, batching, rotation, compression, filtering) **compose by wrapping** rather than as flags on the shipped sinks. This keeps the bundled sinks minimal and honest about what they do, and `buffer` is itself a composition primitive under the same model — `buf.enqueue` is a `Sink`, so it slots into `observer.pipe()` with no adapter.

## Rules

- **Register after plugins.** `observer.use()` after `observer.pipe()` throws.
- **Errors route to `onError`.** A thrown error or rejected promise from any sink is caught by the pipeline runner and dispatched to every registered `observer.onError` handler with `phase: "sink"`. Other sinks continue unaffected.
- **Sinks run concurrently.** Don't share mutable state between sinks.
- **Never re-enter the patched fetch from a sink.** Use the unpatched fetch via `getOriginalFetch()` from `llmvantage/core` (or just use a different transport).
