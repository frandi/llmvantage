# Sinks

A sink is a function `(event: LLMEvent) => void | Promise<void>`. All registered sinks receive the same final event after every plugin has run, so **sinks can assume the data is already compliant** — they never need to re-implement redaction, filtering, or policy checks.

See [../../../../docs/llmvantage-spec.md](../../../../docs/llmvantage-spec.md) §7 for the full contract.

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

## Why composition, not configuration

Sinks are pure leaf functions. All configuration lives in factory closures. All cross-cutting concerns (retry, timeout, batching, rotation, compression, filtering) **compose by wrapping** rather than as flags on the shipped sinks. This keeps the bundled sinks minimal and honest about what they do, and it means `buffer.ts` — the next milestone — will itself be a sink wrapper under this same model: `buffer(innerSink, opts)` returning a new `Sink` that queues and batch-flushes.

## Rules

- **Register after plugins.** `observer.use()` after `observer.pipe()` throws.
- **Errors route to `onError`.** A thrown error or rejected promise from any sink is caught by the pipeline runner and dispatched to every registered `observer.onError` handler with `phase: "sink"`. Other sinks continue unaffected.
- **Sinks run concurrently.** Don't share mutable state between sinks.
- **Never re-enter the patched fetch from a sink.** Use the unpatched fetch via `getOriginalFetch()` from `llmvantage/core` (or just use a different transport).
