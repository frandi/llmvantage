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

`llmvantage` must be imported before any LLM SDK, because the SDK needs to observe the patched `globalThis.fetch`.

```ts
// index.ts — must be the first import in your entry point
import "llmvantage";
import { observer } from "llmvantage";
import { normalizeTokens } from "llmvantage/plugins/normalize-tokens";
import { consoleSink } from "llmvantage/sinks/console";
import Anthropic from "@anthropic-ai/sdk";

observer
  .use(normalizeTokens)
  .pipe(consoleSink)
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

CommonJS is identical, just swap the imports:

```js
require("llmvantage");
const { observer } = require("llmvantage");
const { normalizeTokens } = require("llmvantage/plugins/normalize-tokens");
const { consoleSink } = require("llmvantage/sinks/console");
```

See the [`demos/`](https://github.com/frandi/llmvantage/tree/main/demos) directory for end-to-end examples against Anthropic, OpenAI (Responses API), and Gemini.

## The compliance boundary

Plugins run before any sink receives an event. Once you call `observer.pipe(...)`, adding more plugins throws — making the plugin chain your single enforcement point for PII redaction, field filtering, and policy transforms.

```ts
// Conceptual — only normalizeTokens and consoleSink ship today;
// redactPii, Redis/file sinks, and others are planned.
observer
  .use(redactPii)                       // compliance plugins first
  .use(normalizeTokens)
  .pipe(redisStreamSink(redis))         // sinks only see post-compliance data
  .pipe(fileSink("./events.ndjson"));
```

Everything downstream of a sink — dashboards, collectors, alerting — can treat its input as already compliant and does not need to re-implement policy checks.

## Status

| Area | State |
|---|---|
| Core observer + fetch patch | ✅ done |
| `normalizeTokens` plugin | ✅ done |
| `consoleSink` | ✅ done |
| Other plugins (`redactPii`, `costEstimate`) | planned |
| Sinks (`ndjson-file`, `http`, `redis-stream`) | planned |
| Adapters (axios, `http`/`https`, gRPC, fetch-injector, wrapper) | planned |
| Canary check | planned |
| Backpressure buffer with graceful drain | planned |

## License

MIT
