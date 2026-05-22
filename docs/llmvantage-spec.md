# llmvantage

**Specification Document**

TypeScript / Node.js  ·  v1.6.0  ·  2026

---


# 1. Overview

llmvantage is a lightweight, zero-dependency observability layer for TypeScript/Node.js applications that call large language model APIs. It captures raw request and response data from Anthropic, OpenAI, and Gemini without requiring any changes to existing call sites, and exposes a plugin/sink pipeline for enrichment, redaction, and routing.

A core design principle is the compliance boundary: no event leaves the application until it has passed through the complete plugin pipeline. The pipeline is the enforcement layer for all security, privacy, and compliance requirements. Any consumer downstream of a sink — dashboards, collectors, alerting systems — receives data that is already guaranteed compliant and does not need to re-implement these concerns.


## 1.1  Goals

- Capture every LLM API call automatically once initialized
- Impose near-zero latency overhead on the hot path
- Keep the core module under 100 lines with no external dependencies
- Make every additional capability explicitly opt-in
- Work across all three major providers with a single integration point
- Enforce a single compliance boundary — all policy transforms run before any data is emitted

## 1.2  Non-goals

- This library does not provide a dashboard or storage backend
- It does not enforce rate limits or implement retry logic
- It does not replace a dedicated gateway for routing or load balancing

## 1.3  Package distribution

llmvantage ships as a single npm package: `llmvantage`. All modules — core, adapters, plugins, and sinks — are included in the one package. This keeps installation simple and ensures the compliance pipeline is always version-consistent.

```
npm install llmvantage
```
Adapter modules that depend on optional external libraries declare those as peer dependencies. They are only needed if the corresponding adapter is used. The core package has no required external dependencies.

| Adapter | Peer dependency | Install when |
| --- | --- | --- |
| adapters/grpc-interceptor | @grpc/grpc-js ≥ 1.8 | Using Vertex AI or gRPC-based providers |
| adapters/axios-interceptor | axios ≥ 1.0 | SDK uses axios internally |
| sinks/redis-stream | redis ≥ 4.0 | Using Redis Streams transport |

The `@llmvantage` npm scope is reserved for future packages — for example `@llmvantage/types` if a separate repository needs the `LLMEvent` type without the full library, or `@llmvantage/dashboard` if a reference dashboard is published as a standalone package. The current single-package approach will remain the primary installation path.


# 2. Architecture

The system is composed of four layers that process each captured event in sequence.

| Layer | Module | Responsibility |
| --- | --- | --- |
| Intercept | core.ts | Patches globalThis.fetch, captures request/response, measures latency |
| Adapt | adapters/* | Fallback capture for SDKs that bypass globalThis.fetch (HTTP, gRPC, axios) |
| Transform | plugins/* | Ordered pipeline of pure functions that mutate or enrich the event |
| Emit | sinks/* | Fan-out to one or more destinations after all plugins have run |


## 2.1  Event flow

The following sequence describes the lifecycle of a single LLM call via the primary fetch path. If an adapter is in use, step 2 is replaced by the adapter's interception mechanism — all subsequent steps are identical.

- Application code calls any SDK method (e.g. anthropic.messages.create)
- The SDK internally calls globalThis.fetch (or adapter intercepts at transport/call-site level)
- The patched fetch intercepts the call, records the timestamp, and clones the request body
- The original fetch is called — the actual API request happens here
- The response stream is tee'd: one copy goes to the SDK, one copy is read by the observer
- Once the observer copy is fully consumed, an LLMEvent is constructed
- Each registered plugin runs in order, transforming the event
- All registered sinks receive the final event simultaneously
- The SDK receives its stream copy unmodified and processes it normally

## 2.2  Initialization requirement

llmvantage must be the first import in the application entry point. Any SDK imported before it may capture a reference to the original `globalThis.fetch` and bypass the patch entirely.

```typescript
// index.ts — CORRECT
import "llmvantage";                 // must be first
import Anthropic from "@anthropic-ai/sdk";

// index.ts — WRONG
import Anthropic from "@anthropic-ai/sdk";  // captures original fetch
import "llmvantage";                        // too late
```

# 3. Trust Boundary & Compliance Model

The plugin pipeline is the single compliance enforcement point for the entire application. Every event must pass through the complete plugin chain before it can reach any sink. This means all policy decisions — PII redaction, field filtering, key scrubbing, data minimisation — are made in one place, by one set of rules, applied consistently to every event regardless of which sink or consumer receives it.


## 3.1  The boundary

The trust boundary sits between the plugin pipeline and the sinks. Everything to the left of the boundary is inside the application's trust zone and may contain raw, sensitive data. Everything to the right has been processed and is safe for external consumers.

```
┌──────────────────────────────────────────────────────────────┐
│                     LLM application                         │
│                                                              │
│  raw LLM call                                                │
│      │                                                       │
│      ▼                                                       │
│  [ plugin pipeline ]   ◄── compliance boundary              │
│      │  redactPii                                            │
│      │  normalizeTokens                                      │
│      │  ... your policies ...                                │
│      │                                                       │
│      ▼                                                       │
│  compliant LLMEvent ──► sinks ──► external world            │
│                                                              │
│  nothing crosses this line without passing                   │
│  through every registered plugin                             │
└──────────────────────────────────────────────────────────────┘
```

## 3.2  Downstream consumer guarantee

Any system that reads events from a sink output — Redis streams, files, HTTP collectors, dashboards, alerting services — can treat the received data as already compliant by contract. These consumers do not need to implement their own redaction, filtering, or policy checks. The compliance guarantee is provided upstream, once, by the observer pipeline.

This has three practical consequences:

- New consumers can be added freely without revisiting compliance for each one
- Compliance rules are auditable in a single location — the plugin registration list
- A dashboard or external tool can be built by a separate team without access to the raw prompt or response data

## 3.3  Plugin registration order enforcement

Sinks must only be registered after all required compliance plugins are registered. A sink registered before `redactPii` would receive unredacted events, silently violating the compliance contract. The core enforces this at runtime: once any sink is registered via `observer.pipe()`, subsequent calls to `observer.use()` throw an error immediately.

```
// WRONG — sink registered before compliance plugin
observer.pipe(redisStreamSink(redis));   // receives raw unredacted events
observer.use(redactPii);                 // throws: plugins must precede sinks

// CORRECT — all compliance plugins first, then sinks
observer.use(redactPii);                 // ← compliance boundary established here
observer.use(normalizeTokens);
observer.pipe(redisStreamSink(redis));   // ← only receives post-compliance events
observer.pipe(fileSink('./events.ndjson'));

// CORRECT — chained style (preferred)
observer
  .use(redactPii)
  .use(normalizeTokens)
  .pipe(redisStreamSink(redis))
  .pipe(fileSink('./events.ndjson'));
```
The enforcement is implemented in `core.ts`:

```typescript
let sinksRegistered = false;

export const observer = {
  use(plugin: Plugin): typeof observer {
    if (sinksRegistered) {
      throw new Error(
        '[llmvantage] observer.use() called after observer.pipe(). Plugins must be registered before sinks.'
      );
    }
    plugins.push(plugin);
    return observer;
  },

  pipe(sink: Sink): typeof observer {
    sinksRegistered = true;
    sinks.push(sink);
    return observer;
  },

  onError(handler: ErrorHandler): typeof observer {
    errorHandlers.push(handler);
    return observer;
  },
};
```

## 3.4  Compliance plugin responsibilities

The following categories of plugin are relevant to compliance. Each organisation will define its own set based on applicable regulations and data handling policies.

| Category | Example plugin | Applies to |
| --- | --- | --- |
| PII redaction | redactPii | GDPR, HIPAA, CCPA, internal data policy |
| Secret scrubbing | redactPii (API key pattern) | Credential hygiene, SOC 2 |
| Data minimisation | custom fieldFilter plugin | GDPR Article 5, internal retention policy |
| Payload truncation | custom truncate plugin | Limiting log storage of large prompts |
| Audit enrichment | custom addAuditMeta plugin | SOC 2, internal audit trail requirements |


# 4. Core Module

The core module exports a single named namespace object, `observer`, which groups all registration functions under a clear identity. This avoids name collisions with common library exports such as React's `use` or Node.js stream's `pipe`. The fetch patch is applied as a side effect on import. Plugin-before-sink ordering is enforced at runtime.

All registration methods return `observer` itself, enabling a chainable declaration style. Types are co-exported from the same import so consumers need only one import statement.

```typescript
import { observer } from 'llmvantage';
import type { LLMEvent, Plugin, Sink, ErrorHandler } from 'llmvantage';
```

## 4.1  LLMEvent type

```
type LLMEvent = {
  schemaVersion : string;   // semver, e.g. '1.0'. Increment on breaking changes.
  provider  : 'anthropic' | 'openai' | 'gemini' | 'unknown';
  endpoint  : string;
  request   : unknown;   // parsed JSON body sent to provider
  response  : unknown;   // parsed JSON body received from provider
  latencyMs : number;    // wall-clock ms from fetch start to stream end
  timestamp : string;    // ISO 8601
  streaming : boolean;   // true when response is SSE / text-event-stream
};
```
The core sets `schemaVersion` to the current version string on every event before plugins run. Consumers should read this field before processing and handle or skip events whose version they do not recognise.


## 4.2  Public API

All methods live on the `observer` namespace object and return `observer` for chaining.

| Method | Signature | Description |
| --- | --- | --- |
| `observer.use(plugin)` | (plugin: Plugin) => observer | Appends a plugin. Throws if any sink is already registered. |
| `observer.pipe(sink)` | (sink: Sink) => observer | Appends a sink. Locks the plugin pipeline after first call. |
| `observer.onError(handler)` | (handler: ErrorHandler) => observer | Registers a handler for observer-internal errors. Does not affect the SDK path. |

The `ErrorHandler` signature is `(err: ObserverError) => void` where `ObserverError` carries a `phase` field (`'plugin'`, `'sink'`, or `'stream'`), the original `Error` object, and the partial event if available.

The chained registration pattern is the recommended style:

```typescript
import { observer } from 'llmvantage';
import { redactPii }       from 'llmvantage/plugins/redact-pii';
import { normalizeTokens } from 'llmvantage/plugins/normalize-tokens';
import { redisStreamSink } from 'llmvantage/sinks/redis-stream';

observer
  .use(redactPii)
  .use(normalizeTokens)
  .pipe(redisStreamSink(redis))
  .onError(err => logger.warn('[llmvantage]', err));
```

## 4.3  Design constraints

- The core must never `throw` into the SDK call stack. Observer-internal errors are caught and routed to registered `observer.onError` handlers. If no handler is registered, they are swallowed silently.
- Event emission is fire-and-forget via setImmediate — it never adds latency to the response path.
- The URL filter checks against a hardcoded list of known LLM hostnames. Any URL not matching the list passes through the original `fetch` with zero overhead.
- The core has no external npm dependencies.
- Plugin registration is locked after the first `observer.pipe()` call. Attempting to call `observer.use()` after `observer.pipe()` throws immediately, enforcing the compliance boundary at startup.

# 5. Plugin System

A plugin is a pure function with signature `(event: LLMEvent) => LLMEvent | Promise<LLMEvent>`. Plugins run in registration order. Each plugin receives the output of the previous one. Plugins must return a complete `LLMEvent` — they may add properties via spread but must not remove required fields. All compliance-related plugins must be registered before any sink.


## 5.1  Bundled plugins


### redactPii

Path: `llmvantage/plugins/redact-pii`

Walks the request and response trees recursively and replaces matched patterns with labelled placeholders.

| Pattern | Replacement | Notes |
| --- | --- | --- |
| Email address | [EMAIL] | RFC 5322 simplified |
| Phone number | [PHONE] | US formats |
| API key (sk-...) | [API_KEY] | OpenAI / Anthropic key prefixes |

Custom patterns can be added by extending the `PII_PATTERNS` array before calling `observer.use(redactPii)`.


### normalizeTokens

Path: `llmvantage/plugins/normalize-tokens`

Extracts token usage from provider-specific response schemas and adds a normalized tokens field to the event.

```
// Added to event after plugin runs:
tokens: {
  inputTokens               : number;
  outputTokens              : number;
  totalTokens               : number;
  cachedInputTokens?        : number; // tokens served from prompt cache
  cacheCreationInputTokens? : number; // tokens written to cache (Anthropic only)
} | null
```
| Provider | Input / output | Cache fields | `inputTokens` includes cached? |
| --- | --- | --- | --- |
| Anthropic | usage.input_tokens / output_tokens | usage.cache_read_input_tokens → cachedInputTokens; usage.cache_creation_input_tokens → cacheCreationInputTokens | No (exclusive) |
| OpenAI (Responses API) | usage.input_tokens / output_tokens | usage.input_tokens_details.cached_tokens → cachedInputTokens | Yes (inclusive) |
| OpenAI (Chat Completions) | usage.prompt_tokens / completion_tokens | usage.prompt_tokens_details.cached_tokens → cachedInputTokens | Yes (inclusive) |
| Gemini | usageMetadata.promptTokenCount / candidatesTokenCount | usageMetadata.cachedContentTokenCount → cachedInputTokens | Yes (inclusive) |


## 5.2  Writing a custom plugin

```typescript
// llmvantage/plugins/cost-estimate
import type { Plugin } from 'llmvantage';

const COST_PER_1K: Record<string, { in: number; out: number }> = {
  "claude-sonnet-4-20250514" : { in: 0.003,  out: 0.015 },
  "gpt-4o"                   : { in: 0.005,  out: 0.015 },
  "gemini-1.5-pro"           : { in: 0.00125, out: 0.005 },
};

export const costEstimate: Plugin = (event) => {
  const tokens = (event as any).tokens;
  const model  = (event.request as any)?.model as string;
  const rates  = COST_PER_1K[model];
  if (!tokens || !rates) return event;
  return {
    ...event,
    estimatedCostUsd:
      (tokens.inputTokens  / 1000) * rates.in +
      (tokens.outputTokens / 1000) * rates.out,
  };
};
```

## 5.3  Concurrency model

The observer handles concurrent LLM calls safely by design. Each invocation of the patched fetch creates an isolated async closure with its own local copies of all state — start time, request body, stream reader, and accumulated chunks. There is no shared mutable state between concurrent pipeline executions.

Because pipelines run concurrently and each has a variable number of async steps, the order events arrive at sinks is not guaranteed to match the order LLM calls were made. Sort by `event.timestamp` on the read side if strict ordering is required, or use `createBuffer` with ordered drain for strict FIFO.

Plugins must be pure functions with no external mutable state. A plugin that closes over a shared variable will produce incorrect results under concurrent calls.

```typescript
// WRONG — shared mutable state, breaks under concurrency
let callCount = 0;
export const countCalls: Plugin = (event) => {
  callCount++;                        // race condition
  return { ...event, callCount };
};

// CORRECT — pure function, all state carried in the event
export const countCalls: Plugin = (event) => ({
  ...event,
  callCount: ((event as any).callCount ?? 0) + 1,
});
```

# 6. Adapter System

The global fetch patch covers the majority of cases, but some SDKs bypass globalThis.fetch entirely. The adapter system provides opt-in fallback mechanisms for these scenarios. All adapters produce the same LLMEvent type and feed into the same plugin/sink pipeline as the core patch.


## 6.1  Adapter selection guide

| Scenario | Adapter | Notes |
| --- | --- | --- |
| SDK accepts custom fetch option | fetch-injector | Cleanest approach — no global side effects |
| SDK uses axios internally | axios-interceptor | Patches request + response interceptor chain |
| SDK uses node:http / node:https directly | http-patch | Wraps http.request at module level |
| SDK uses gRPC (e.g. Vertex AI) | grpc-interceptor | Injects channel interceptor at client construction |
| Unknown protocol / no other option | wrapper | Explicit call-site wrapping; protocol-agnostic |


## 6.2  Bundled adapters


### fetch-injector

Path: `llmvantage/adapters/fetch-injector`

Exports `instrumentedFetch(originalFetch?)`, a factory that returns a fully instrumented fetch function. Pass the result directly into the SDK constructor. Preferred over the global patch when the SDK exposes a fetch option.

```typescript
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { instrumentedFetch } from 'llmvantage/adapters/fetch-injector';

const myFetch = instrumentedFetch();
const anthropic = new Anthropic({ fetch: myFetch });
const openai    = new OpenAI({ fetch: myFetch });
```

### axios-interceptor

Path: `llmvantage/adapters/axios-interceptor`

Exports `patchAxios(instance?)`. When called with no argument, patches the global axios instance.

```typescript
import { patchAxios } from 'llmvantage/adapters/axios-interceptor';
patchAxios();              // patches global axios instance
```

### http-patch

Path: `llmvantage/adapters/http-patch`

Exports `patchHttpModules()`. Wraps `http.request` and `https.request` at the Node.js module level.

```typescript
import { patchHttpModules } from 'llmvantage/adapters/http-patch';
patchHttpModules();   // call once before any SDK import
```

### grpc-interceptor

Path: `llmvantage/adapters/grpc-interceptor`

Exports `createObserverInterceptor()`. Returns a `grpc.Interceptor` compatible with `@grpc/grpc-js`.

```typescript
import { PredictionServiceClient } from "@google-cloud/aiplatform";
import { createObserverInterceptor } from 'llmvantage/adapters/grpc-interceptor';

const client = new PredictionServiceClient({
  grpc: { interceptors: [createObserverInterceptor()] },
});
```

### wrapper (universal fallback)

Path: `llmvantage/adapters/wrapper`

Exports `observed(provider, endpoint, requestBody, fn)`. A protocol-agnostic explicit wrapper. Works for any SDK, any protocol, any version.

```typescript
import { observed } from 'llmvantage/adapters/wrapper';

const response = await observed(
  'gemini',
  'generateContent',
  { model, contents },
  () => vertexClient.predict({ instances: [...] })
);
```

## 6.3  Canary check

A canary check verifies at startup that the active capture mechanism is working. If no event is received within the timeout, a warning is logged.

```typescript
import { observer } from 'llmvantage';

export async function runCanary(timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.warn('[llmvantage] canary: no event captured — check adapter');
      resolve(false);
    }, timeoutMs);
    observer.use((event) => {
      clearTimeout(timer);
      resolve(true);
      return event;
    });
  });
}
```

# 7. Sink System

A sink is a function with signature `(event: LLMEvent) => void | Promise<void>`. All registered sinks receive the same final event after all plugins have run. Sinks run concurrently. Because sinks only receive events that have passed through the full plugin pipeline, they can assume the data is already compliant.


## 7.1  Bundled sinks


### consoleSink

Path: `llmvantage/sinks/console`

Writes a compact JSON summary to stdout. Intended for development only.

**Durability:** none. Suitable for `NODE_ENV=development` only.


### fileSink(path)

Path: `llmvantage/sinks/ndjson-file`

Factory function. Appends one JSON line per event using `appendFileSync`.

**Durability:** best-effort. Blocking writes may affect event loop latency under high throughput. Suitable for single-instance, low-volume use cases.


### httpSink(url, headers?)

Path: `llmvantage/sinks/http`

Factory function. POSTs each event as JSON using the original (unpatched) `fetch`. Fires and forgets.

**Durability:** none. No retry, no timeout enforcement. Use `createBuffer` in front of this sink for durable delivery.


### redisStreamSink(client, opts?)

Path: `llmvantage/sinks/redis-stream`

Factory function. Appends events to a Redis stream via `XADD` with optional `MAXLEN` trim.

**Durability:** good. Redis persists the stream to disk. Recommended transport for dashboard integration and multi-consumer scenarios.

```typescript
import { createClient } from 'redis';
import type { LLMEvent } from 'llmvantage';

type Options = { streamKey?: string; maxLen?: number };

export function redisStreamSink(
  client: ReturnType<typeof createClient>,
  opts: Options = {}
) {
  const { streamKey = 'llm:events', maxLen = 10_000 } = opts;
  return async (event: LLMEvent): Promise<void> => {
    await client.xAdd(
      streamKey,
      "*",
      { payload: JSON.stringify(event) },
      { TRIM: { strategy: "MAXLEN", threshold: maxLen, strategyModifier: "~" } }
    );
  };
}
```

## 7.2  Buffer and graceful drain

For high-throughput deployments, `createBuffer` decouples the observer pipeline from the sinks. Events are enqueued synchronously, and a drain loop flushes batches at a controlled interval.

The most important production concern is graceful drain on process shutdown. If the process receives SIGTERM while events remain in the buffer, those events must be flushed before exit — otherwise compliance records are silently lost.

```typescript
// llmvantage/buffer.ts — graceful drain contract
export function createBuffer(handler: DrainHandler, opts: BufferOptions = {}) {
  const queue: LLMEvent[] = [];
  const interval = setInterval(drain, opts.flushInterval ?? 100);

  async function flush(): Promise<void> {
    clearInterval(interval);
    while (queue.length > 0) {
      const batch = queue.splice(0, opts.batchSize ?? 20);
      await handler(batch).catch(() => {});
    }
  }

  // Both signals must be handled
  process.once('SIGTERM', () => flush().then(() => process.exit(0)));
  process.once('beforeExit', flush);

  return { enqueue, flush, get depth() { return queue.length; } };
}
```
When using the buffer, route `observer.onError` to monitor drop events — a non-zero drop count means the sink is slower than the call rate.


## 7.3  Writing a custom sink

Any function matching the Sink signature can be registered. The example below writes to a Redis stream.

```typescript
import { observer }        from 'llmvantage';
import { redactPii }       from 'llmvantage/plugins/redact-pii';
import { normalizeTokens } from 'llmvantage/plugins/normalize-tokens';
import { redisStreamSink } from 'llmvantage/sinks/redis-stream';
import { createClient }    from 'redis';

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

// registration — always after all compliance plugins
observer
  .use(redactPii)
  .use(normalizeTokens)
  .pipe(redisStreamSink(redis, { maxLen: 50_000 }));
```

# 8. Known Limitations

The following are known characteristics of the observer's design. The rightmost column describes an application-side response the integrating application may choose to apply — none are mandatory.

| Characteristic | Condition / impact | Application-side response (if needed) |
| --- | --- | --- |
| SDK bypasses globalThis.fetch | Calls silently not captured | Run canary check at startup; select an adapter from Section 6 |
| Streaming tee() edge cases | Stream errors can corrupt SDK copy | Attach error handler to the observer stream reader |
| Silent capture failure | No signal when events stop flowing | Register observer.onError handler; emit heartbeat metric; alert on zero events |
| Raw payloads contain secrets | PII or API keys reach sink destination | Register redactPii (or equivalent) before any sink |
| Patches a global | All fetch calls in the process pass through the patch | Keep URL filter tight; mock the patched fetch in tests |
| Async emit can drop events | Event loss under high load or slow sinks | Use createBuffer with capped queue; register observer.onError to monitor drop count |
| Token counts require parsing | Schema drift breaks extraction on provider SDK updates | Use normalizeTokens plugin; pin provider SDK versions in package.json |
| gRPC streaming responses | Only the first message is captured per call | Extend grpc-interceptor to accumulate all stream messages |
| http-patch wraps entire module | All node:http traffic passes through the patch | Keep hostname filter tight; prefer fetch-injector when available |
| Stateful plugins break under concurrency | Race conditions; incorrect aggregated values | Write plugins as pure functions; use atomics only if external state is unavoidable |
| Sink delivery order not guaranteed | Events arrive out of call-start order under concurrency | Sort by event.timestamp on the read side; use createBuffer with ordered drain for strict FIFO |


# 9. Usage Reference


## 9.1  Minimal setup

This is all that is required to start capturing events.

```typescript
// index.ts
import "llmvantage";
import { observer }   from 'llmvantage';
import { consoleSink } from 'llmvantage/sinks/console';

observer.pipe(consoleSink);

// rest of app...
import Anthropic from "@anthropic-ai/sdk";
```

## 9.2  Production setup

```typescript
// index.ts
import "llmvantage";
import { observer }        from 'llmvantage';
import { redactPii }       from 'llmvantage/plugins/redact-pii';
import { normalizeTokens } from 'llmvantage/plugins/normalize-tokens';
import { costEstimate }    from 'llmvantage/plugins/cost-estimate';
import { redisStreamSink } from 'llmvantage/sinks/redis-stream';
import { fileSink }        from 'llmvantage/sinks/ndjson-file';
import { runCanary }       from 'llmvantage/canary';
import { createClient }    from 'redis';

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

// Chained pipeline — compliance plugins first, then sinks
observer
  .use(redactPii)         // PII removed — GDPR / CCPA
  .use(normalizeTokens)   // unified token schema
  .use(costEstimate)      // cost enrichment
  .pipe(redisStreamSink(redis, { maxLen: 50_000 }))
  .pipe(fileSink('./llm-calls.ndjson'))
  .onError(err => console.warn('[llmvantage]', err.phase, err.error.message));

// verify capture is working
runCanary().then(ok => { if (!ok) process.exit(1); });
```

## 9.3  gRPC / Vertex AI setup

```typescript
// index.ts — for Vertex AI or other gRPC-based providers
import "llmvantage";
import { observer }        from 'llmvantage';
import { createObserverInterceptor } from 'llmvantage/adapters/grpc-interceptor';
import { redactPii }       from 'llmvantage/plugins/redact-pii';
import { normalizeTokens } from 'llmvantage/plugins/normalize-tokens';
import { httpSink }        from 'llmvantage/sinks/http';
import { PredictionServiceClient } from "@google-cloud/aiplatform";

observer
  .use(redactPii)
  .use(normalizeTokens)
  .pipe(httpSink('https://collector.internal/events'))
  .onError(err => console.warn('[llmvantage]', err.phase, err.error.message));

export const vertexClient = new PredictionServiceClient({
  grpc: { interceptors: [createObserverInterceptor()] },
});
```

# 10. File Structure

The package ships as `llmvantage`. All paths are importable as subpath exports.

```
llmvantage/
├── package.json                     # name: "llmvantage", exports map
├── core.ts                          # observer namespace, fetch patch, plugin/sink registry
├── canary.ts                        # startup capture verification
├── buffer.ts                        # backpressure buffer with graceful drain
├── adapters/
│   ├── fetch-injector.ts            # custom fetch for SDK constructor
│   ├── axios-interceptor.ts         # for axios-based SDKs (peer dep: axios)
│   ├── http-patch.ts                # for node:http/https direct usage
│   ├── grpc-interceptor.ts          # for gRPC SDKs (peer dep: @grpc/grpc-js)
│   └── wrapper.ts                   # universal explicit fallback
├── plugins/
│   ├── redact-pii.ts                # PII scrubbing (compliance)
│   ├── normalize-tokens.ts          # unified token counts
│   └── cost-estimate.ts             # per-model cost field (optional)
└── sinks/
    ├── console.ts                   # stdout summary (dev only)
    ├── ndjson-file.ts               # append to .ndjson file (best-effort)
    ├── http.ts                      # POST to HTTP endpoint (no retry)
    └── redis-stream.ts              # Redis stream (durable, recommended)
```

# 11. Compatibility

| Requirement | Minimum version | Notes |
| --- | --- | --- |
| Node.js | 18.0 | Native fetch required for core patch |
| @anthropic-ai/sdk | 0.20+ | Uses globalThis.fetch; supports fetch option |
| openai (npm) | 4.0+ | Uses globalThis.fetch; supports fetch option |
| @google/generative-ai | 0.2+ | Uses globalThis.fetch internally |
| @google-cloud/aiplatform | any | gRPC — use grpc-interceptor adapter |
| @grpc/grpc-js | 1.8+ | Required for grpc-interceptor adapter |
| axios | 1.0+ | Required only for axios-interceptor adapter |
| redis (npm) | 4.0+ | Required for redis-stream sink |
| TypeScript | 5.0+ | Strict mode recommended |


# 12. Dashboard Integration

The llmvantage package has no built-in dashboard. A monitoring UI is a separate application that consumes events from a sink output. Because events are guaranteed compliant by the time they reach any sink, the dashboard has no compliance obligations of its own.


## 12.1  Recommended transport: Redis Streams

Redis Streams is the recommended bus between llmvantage and a dashboard for most deployments.

| Option | Best for | Trade-offs |
| --- | --- | --- |
| NDJSON file | Dev / single instance | No infra; no real-time push; no multi-producer |
| Redis Streams | Most production cases | Single Redis instance; real-time; multi-consumer groups |
| Kafka + Postgres | High volume, long retention | Full data platform ops; best query capability |


## 12.2  Dashboard API pattern

The dashboard backend reads from the Redis stream and exposes two endpoints: REST for historical queries and SSE for the live feed.

```typescript
// dashboard-api/server.ts (Fastify)
import Fastify from 'fastify';
import { createClient } from 'redis';
import type { LLMEvent } from 'llmvantage';

const app = Fastify();
const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

// historical events for charts
app.get('/api/events', async (req, reply) => {
  const { count = '100', provider } = req.query as Record<string, string>;
  const raw = await redis.xRevRange('llm:events', '+', '-', { COUNT: parseInt(count) });
  const events = raw
    .map(e => JSON.parse(e.message.payload) as LLMEvent)
    .filter(e => !provider || e.provider === provider);
  return reply.send(events);
});

// real-time SSE feed
app.get('/api/stream', async (req, reply) => {
  reply.raw.setHeader('Content-Type', 'text/event-stream');
  reply.raw.setHeader('Cache-Control', 'no-cache');
  let lastId = '$';
  const poll = async () => {
    const entries = await redis.xRead([{ key: 'llm:events', id: lastId }], { COUNT: 50, BLOCK: 1000 });
    if (entries) {
      for (const { messages } of entries) {
        for (const msg of messages) {
          lastId = msg.id;
          reply.raw.write(`data: ${msg.message.payload}\n\n`);
        }
      }
    }
    if (!reply.raw.destroyed) setTimeout(poll, 0);
  };
  poll();
});
```

## 12.3  Shared event type

The llmvantage package exports `LLMEvent` directly, so both the application and the dashboard import from the same source.

```typescript
// Both sides import from llmvantage directly
import type { LLMEvent } from 'llmvantage';

// If the dashboard is in a separate repo with no llmvantage dep:
// npm install @llmvantage/types   (reserved scope for future packages)
import type { LLMEvent } from '@llmvantage/types';
```

## 12.4  End-to-end data flow

```
LLM app (trusted zone)
─────────────────────────────────────────────
  SDK call
    │
    ▼ fetch intercept / adapter
    │
  [ plugin pipeline ]  ← compliance boundary
    │  redactPii
    │  normalizeTokens
    │  costEstimate
    │
  redis-stream sink
    │ XADD llm:events *
    ▼

Redis Stream  (compliant data only beyond this point)
─────────────────────────────────────────────
    │ XREAD / consumer group
    ▼

Dashboard app (no compliance obligations)
─────────────────────────────────────────────
  GET /api/events   → historical charts
  GET /api/stream   → live SSE feed
  GET /api/stats    → aggregated metrics
    │
    ▼
  Browser UI
```