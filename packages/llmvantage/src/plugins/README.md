# Plugins

Plugins are pure functions `(event: LLMEvent) => LLMEvent | Promise<LLMEvent>` that run in registration order on every captured event **before** any sink receives it. They are the compliance boundary of `llmvantage` — any transformation needed for privacy, enrichment, or normalization belongs here.

See [../../../../docs/llmvantage-spec.md](../../../../docs/llmvantage-spec.md) §3 and §5 for the full contract.

## Registration

Plugins must be registered before any sink. Once `observer.pipe()` is called, further `observer.use()` calls throw.

```typescript
import { observer } from 'llmvantage';
import { redactPii }       from 'llmvantage/plugins/redact-pii';
import { normalizeTokens } from 'llmvantage/plugins/normalize-tokens';
import { consoleSink }     from 'llmvantage/sinks/console';

observer
  .use(redactPii)         // compliance first
  .use(normalizeTokens)   // enrichment
  .pipe(consoleSink);
```

---

## `redactPii`

**Path:** `llmvantage/plugins/redact-pii`

Walks `event.request` and `event.response` recursively and replaces matched patterns in string leaves with labelled placeholders. Other event fields (`provider`, `endpoint`, `latencyMs`, `timestamp`, `streaming`, `schemaVersion`) are not touched.

### Default patterns

| Category | Replacement | Matches |
|---|---|---|
| Email | `[EMAIL]` | `alice@example.com`, `bob.smith+filter@sub.co.uk` (RFC 5322 simplified) |
| US phone | `[PHONE]` | `(555) 555-5555`, `555-555-5555`, `555.555.5555`, `+1 555 555 5555`, `5555555555` |
| API key (`sk-…`) | `[API_KEY]` | OpenAI (`sk-…`, `sk-proj-…`) and Anthropic (`sk-ant-api03-…`) keys, ≥20 trailing chars |

### Not covered by default

- Credit card / IBAN / SSN
- Cloud credentials: AWS (`AKIA…`), GCP service-account keys, GitHub tokens (`ghp_…`, `gho_…`), Slack tokens (`xox[bpars]-…`), Stripe (`sk_live_…`, `sk_test_…`), JWTs
- Non-US phone formats
- IP / MAC / physical addresses, person names
- Object **keys** (the walker inspects values only; schema keys like `authorization` are not scrubbed)

### Extending

`PII_PATTERNS` is exported as a mutable array. Push additional patterns **before** calling `observer.use(redactPii)`:

```typescript
import { PII_PATTERNS, redactPii } from 'llmvantage/plugins/redact-pii';

PII_PATTERNS.push(
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g,           replacement: '[AWS_KEY]' },
  { pattern: /\b(?:\d[ -]?){13,19}\b/g,         replacement: '[CARD]' },
  { pattern: /\bghp_[A-Za-z0-9]{36}\b/g,        replacement: '[GITHUB_TOKEN]' },
);

observer.use(redactPii);
```

Patterns run in array order; use the `g` flag so all occurrences in a string are replaced.

### Design notes

- **No `JSON.stringify` round-trip** — the walker traverses the parsed tree directly and only regex-replaces string leaves.
- **Structural sharing** — when no pattern matches inside a subtree, the original object/array reference is returned, avoiding allocation.
- **Synchronous** — no Promise overhead.
- **Safe under concurrency** — pure function, no shared mutable state beyond the user-controlled `PII_PATTERNS` array.
- **Streaming responses** — when the response body is a raw SSE string, it is still scanned (top-level string branch).

---

## `normalizeTokens`

**Path:** `llmvantage/plugins/normalize-tokens`

Extracts token usage from provider-specific response schemas and adds a unified `tokens` field to the event.

```typescript
// Shape added to the event:
tokens: {
  inputTokens:  number;
  outputTokens: number;
  totalTokens:  number;
  cachedInputTokens?:        number; // tokens served from prompt cache
  cacheCreationInputTokens?: number; // tokens written to cache (Anthropic only)
} | null
```

### Provider mapping

| Provider | Input / output | Cache | `inputTokens` includes cached? |
|---|---|---|---|
| Anthropic | `usage.input_tokens` / `output_tokens` | `usage.cache_read_input_tokens` → `cachedInputTokens`; `usage.cache_creation_input_tokens` → `cacheCreationInputTokens` | **No** — `input_tokens` is exclusive of cached/created |
| OpenAI (Responses API) | `usage.input_tokens` / `output_tokens` | `usage.input_tokens_details.cached_tokens` → `cachedInputTokens` | **Yes** — `input_tokens` is inclusive |
| OpenAI (Chat Completions) | `usage.prompt_tokens` / `completion_tokens` | `usage.prompt_tokens_details.cached_tokens` → `cachedInputTokens` | **Yes** — `prompt_tokens` is inclusive |
| Gemini | `usageMetadata.promptTokenCount` / `candidatesTokenCount` | `usageMetadata.cachedContentTokenCount` → `cachedInputTokens` | **Yes** — `promptTokenCount` is inclusive |

Cache fields are only set when the source value is a finite number; otherwise the key is omitted (no `undefined`). Only Anthropic exposes a cache-write counter; for OpenAI and Gemini, `cacheCreationInputTokens` is always absent.

Note the inclusive-vs-exclusive split: a cost-estimate plugin that wants to bill cached input at a discount should compute the fresh-input portion as `inputTokens - (cachedInputTokens ?? 0)` for OpenAI and Gemini, while Anthropic's `inputTokens` is already the fresh portion.

If the response is missing, is not an object, belongs to an unknown provider, or lacks the expected fields, `tokens` is set to `null`. When only input/output are available, `totalTokens` falls back to `inputTokens + outputTokens`.

### Type export

```typescript
import type { EventWithTokens, NormalizedTokens } from 'llmvantage/plugins/normalize-tokens';
```

Downstream plugins (e.g. a cost-estimate plugin) can consume `EventWithTokens` after `normalizeTokens` has run.

---

## Writing a custom plugin

```typescript
// plugins/cost-estimate.ts
import type { Plugin } from 'llmvantage';
import type { EventWithTokens } from 'llmvantage/plugins/normalize-tokens';

const COST_PER_1K: Record<string, { in: number; out: number }> = {
  'claude-sonnet-4-5': { in: 0.003,   out: 0.015 },
  'gpt-4o':            { in: 0.005,   out: 0.015 },
  'gemini-1.5-pro':    { in: 0.00125, out: 0.005 },
};

export const costEstimate: Plugin = (event) => {
  const { tokens } = event as EventWithTokens;
  const model = (event.request as { model?: string } | undefined)?.model;
  const rates = model ? COST_PER_1K[model] : undefined;
  if (!tokens || !rates) return event;
  return {
    ...event,
    estimatedCostUsd:
      (tokens.inputTokens  / 1000) * rates.in +
      (tokens.outputTokens / 1000) * rates.out,
  };
};
```

### Rules

- **Pure function.** No shared mutable state — the observer runs pipelines concurrently; a closed-over counter is a race condition.
- **Return a complete `LLMEvent`.** Add fields via spread; never remove required ones.
- **Register before sinks.** `observer.use()` after `observer.pipe()` throws.
- **Order matters.** Each plugin receives the output of the previous one — put compliance plugins (redaction, filtering) first.
