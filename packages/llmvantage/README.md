# llmvantage

[![npm version](https://img.shields.io/npm/v/llmvantage.svg)](https://www.npmjs.com/package/llmvantage)
[![npm downloads](https://img.shields.io/npm/dm/llmvantage.svg)](https://www.npmjs.com/package/llmvantage)
[![license](https://img.shields.io/npm/l/llmvantage.svg)](https://github.com/frandi/llmvantage/blob/main/packages/llmvantage/LICENSE)
[![node](https://img.shields.io/node/v/llmvantage.svg)](https://www.npmjs.com/package/llmvantage)

Lightweight, zero-dependency observability layer for LLM API calls in TypeScript/Node.js.

`llmvantage` captures raw request/response data from **Anthropic**, **OpenAI**, and **Gemini** without changing your existing call sites, and routes every event through a single plugin pipeline before it reaches any sink — your one enforcement point for redaction, enrichment, and policy.

## Install

```bash
npm install llmvantage
```

Node.js 18+. Ships both ESM and CommonJS builds.

## Quick start

`llmvantage` must be imported **before any LLM SDK**, because the SDK needs to observe the patched `globalThis.fetch`. The SDK must also use the global `fetch` rather than a bundled HTTP client — see [SDK compatibility](#sdk-compatibility) below for which versions work.

```ts
// index.ts — must be the first import in your entry point
import "llmvantage";
import { observer } from "llmvantage";
import { redactPii } from "llmvantage/plugins/redact-pii";
import { normalizeTokens } from "llmvantage/plugins/normalize-tokens";
import { consoleSink } from "llmvantage/sinks/console";
import Anthropic from "@anthropic-ai/sdk";

observer
  .use(redactPii)                     // compliance plugins first
  .use(normalizeTokens)
  .pipe(consoleSink)                  // sinks only see post-compliance events
  .onError((err) => console.warn("[llmvantage]", err.phase, err.error.message));

const client = new Anthropic();
await client.messages.create({
  model: "claude-haiku-4-5",
  max_tokens: 128,
  messages: [{ role: "user", content: "Say hi" }],
});
// → {"t":"...","provider":"anthropic","endpoint":"/v1/messages","latencyMs":412,
//    "streaming":false,"tokens":{"inputTokens":12,"outputTokens":8,"totalTokens":20}}
```

CommonJS is identical — just swap the imports:

```js
require("llmvantage");
const { observer } = require("llmvantage");
const { normalizeTokens } = require("llmvantage/plugins/normalize-tokens");
const { consoleSink } = require("llmvantage/sinks/console");
```

End-to-end examples against Anthropic, OpenAI (Responses API), and Gemini live in the [`demos/`](https://github.com/frandi/llmvantage/tree/main/demos) directory of the repo.

## SDK compatibility

`llmvantage` intercepts LLM calls by patching `globalThis.fetch`. An SDK is captured only if it routes its requests through that global — SDKs that bundle their own HTTP client (e.g. `node-fetch`) bypass the patch silently. If your sinks never receive events for a particular provider, this is the most likely cause.

| SDK | Minimum version | Notes |
|---|---|---|
| `@anthropic-ai/sdk` | any recent version | Uses `globalThis.fetch`. |
| `openai` | **`^5.0.0`** | v4 vendors `node-fetch` via its `_shims/node-runtime.js` and is **not** intercepted. v5+ uses native fetch. |
| `@google/genai` | any recent version | Uses `globalThis.fetch`. |

For SDKs that can't be upgraded (or for non-fetch transports — LangChain, internal proxies, replay tooling), use [`observer.ingest()`](#ingesting-events-manually) to push events through the same plugin chain manually.

## The compliance boundary

Plugins run before any sink receives an event. Once you call `observer.pipe(...)`, adding more plugins throws — making the plugin chain your single enforcement point for PII redaction, field filtering, and policy transforms.

```ts
observer
  .use(redactPii)                     // compliance plugins first
  .use(normalizeTokens)
  .pipe(createBuffer(batchHandler))   // sinks only see post-compliance data
  .pipe(fileSink("./events.ndjson"));
```

Everything downstream of a sink — dashboards, collectors, alerting — can treat its input as already compliant and does not need to re-implement policy checks.

## Ingesting events manually

The fetch patch covers any LLM call that goes through `globalThis.fetch`. For everything else — an SDK wrapper that already has structured call data (LangChain, an internal proxy), a non-fetch transport, a replay of historical events — call `observer.ingest()` to push an event through the same plugin chain and sinks.

```ts
import { observer } from "llmvantage";

await observer.ingest({
  provider: "anthropic",
  endpoint: "/v1/messages",
  request:  { model, messages },
  response: result,
  latencyMs: 421,
  streaming: false,
  // timestamp is optional — defaults to new Date().toISOString()
});
```

Every event carries a `source: "fetch" | "manual"` field so sinks can distinguish wire-captured events from wrapper-fed ones. The returned promise resolves after every sink has run, which makes the call awaitable in tests and shutdown paths.

> **Avoid double-counting.** If a wrapper calls `observer.ingest()` for a request that *also* goes through `fetch`, you'll get two events (one per path). Either filter by `source` in your sink, or stop the wrapper from forwarding for providers the fetch patch already covers.

## What's included

| | Import | Purpose |
|---|---|---|
| **Plugins** | | |
| `normalizeTokens` | `llmvantage/plugins/normalize-tokens` | Unified `{ inputTokens, outputTokens, totalTokens, cachedInputTokens?, cacheCreationInputTokens? }` across providers |
| `redactPii` | `llmvantage/plugins/redact-pii` | Tree-walker redaction — emails, US phones, `sk-*` API keys (extensible) |
| **Sinks** | | |
| `consoleSink` | `llmvantage/sinks/console` | One-line JSON summary to stdout (dev) |
| `fileSink(path)` | `llmvantage/sinks/ndjson-file` | Append NDJSON via persistent `WriteStream` with `beforeExit` drain |
| `httpSink(url, headers?)` | `llmvantage/sinks/http` | POST each event as JSON (uses the unpatched fetch) |
| **Primitives** | | |
| `createBuffer` | `llmvantage` (root) | In-memory bounded queue + interval-flushed batching; graceful `SIGTERM`/`beforeExit` drain |
| `observer.ingest(event)` | `llmvantage` (root) | Push a non-fetch event through the same plugin chain + sinks (stamped `source: "manual"`) |

Deep-dive docs:

- Plugins → [plugins/README.md](https://github.com/frandi/llmvantage/blob/main/packages/llmvantage/src/plugins/README.md)
- Sinks, composition patterns, and buffering → [sinks/README.md](https://github.com/frandi/llmvantage/blob/main/packages/llmvantage/src/sinks/README.md)

## Extending

- **Custom plugin** — any function `(event) => event | Promise<event>` is a valid plugin. Add it with `observer.use(myPlugin)` **before** any `.pipe()`.
- **Custom sink** — any function `(event) => void | Promise<void>` is a valid sink. Add it with `observer.pipe(mySink)`.
- **Batching any sink** — wrap with `createBuffer`:
  ```ts
  const buf = createBuffer(async (batch) => {
    await Promise.all(batch.map(mySink));
  }, { batchSize: 50, flushInterval: 500 });
  observer.pipe(buf.enqueue);
  ```
- **Retry / timeout / rate-limit** — compose by wrapping; see the `sinks/README.md` composition-patterns section for copy-paste snippets.

## Status

| Area | State |
|---|---|
| Core observer + fetch patch | ✅ done |
| `normalizeTokens` plugin | ✅ done |
| `redactPii` plugin | ✅ done |
| `consoleSink` | ✅ done |
| `fileSink` (NDJSON) | ✅ done |
| `httpSink` | ✅ done |
| `createBuffer` (batching + graceful drain) | ✅ done |
| `costEstimate` plugin | planned |
| `redisStreamSink` | planned |
| Adapters (axios, `http`/`https`, gRPC, fetch-injector, wrapper) | planned |
| Canary check | planned |

See the [specification](https://github.com/frandi/llmvantage/blob/main/docs/llmvantage-spec.md) for the full roadmap.

## Repository & contributions

Source, issues, and contribution guide: [github.com/frandi/llmvantage](https://github.com/frandi/llmvantage). The repo's [top-level README](https://github.com/frandi/llmvantage/blob/main/README.md) covers the developer workflow (clone → install → test → build).

## License

MIT
