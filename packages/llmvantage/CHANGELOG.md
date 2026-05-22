# Changelog

All notable changes to the `llmvantage` package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Until `1.0.0`, minor version bumps may include breaking changes (they will be called out explicitly).

## [0.3.0] - 2026-05-23

### Added

- `normalizeTokens` now surfaces cache-token usage. Two optional fields are added to `NormalizedTokens`:
  - `cachedInputTokens` — tokens served from prompt cache. Sourced from `usage.cache_read_input_tokens` (Anthropic), `usage.input_tokens_details.cached_tokens` (OpenAI Responses API), `usage.prompt_tokens_details.cached_tokens` (OpenAI Chat Completions), and `usageMetadata.cachedContentTokenCount` (Gemini).
  - `cacheCreationInputTokens` — tokens written to cache. Anthropic-only; sourced from `usage.cache_creation_input_tokens`. The other providers have no equivalent counter.
- Fields are only set when the source value is a finite number, so existing consumers see no new `undefined` keys.
- Demo: `demos/04-cache` — CLI-driven validation harness that fires real Anthropic / OpenAI / Gemini calls and prints the normalized fields next to the raw provider `usage` block. Flags: `--provider`, `--model`, `--runs`, `--prompt-size`, `--cache-mode`, `--ttl`.

### Docs

- Plugin README and spec document the inclusive-vs-exclusive split: Anthropic's `input_tokens` is exclusive of cached tokens; OpenAI and Gemini are inclusive. Downstream cost plugins should subtract `cachedInputTokens` for the latter two.
- Package README gains an **SDK compatibility** section. The `globalThis.fetch` patch silently bypasses SDKs that vendor their own HTTP client. Notably, `openai` SDK v4 uses `node-fetch` and is **not** intercepted — `openai@^5.0.0` is required. Anthropic and `@google/genai` use native fetch and work as-is.

## [0.2.0] - 2026-04-21

### Added

- `redactPii` plugin — tree-walker redaction for emails, US phones, and `sk-*` API keys. Extensible via the exported `PII_PATTERNS` array.
- `fileSink(path)` — append NDJSON to a persistent `WriteStream`, with `beforeExit` drain.
- `httpSink(url, headers?)` — POST each event as JSON via the unpatched fetch.
- `createBuffer` — in-memory bounded queue + interval-flushed batching primitive, with `SIGTERM`/`beforeExit` graceful drain and configurable drop policy.
- `observer.ingest(event)` — push non-fetch events (LangChain wrappers, internal proxies, replay) through the same plugin chain and sinks.
- Every `LLMEvent` carries a `source: "fetch" | "manual"` discriminator (schema version bumped to `1.1`).

### Docs

- READMEs split by audience: package README is the npm page; root README covers the contributor workflow.
- Sinks README documents composition patterns (retry, timeout, rotation, batching) and the shutdown contract.
- Demo: `demos/03-buffer` — batched delivery with graceful drain over a burst of real Anthropic calls.

## [0.1.0] - 2026-04-21

### Added

- Initial release.
- Core observer with `globalThis.fetch` interception for Anthropic, OpenAI, and Gemini.
- `normalizeTokens` plugin — unified `{ inputTokens, outputTokens, totalTokens }` across providers.
- `consoleSink` — one-line JSON summary to stdout.
- Demos: `01-esm` (TypeScript ESM, Anthropic + Gemini) and `02-cjs` (CommonJS, OpenAI Responses API).

[0.3.0]: https://github.com/frandi/llmvantage/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/frandi/llmvantage/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/frandi/llmvantage/releases/tag/v0.1.0
