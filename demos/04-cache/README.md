# Demo 04 — Cache token validation

Validates that `normalizeTokens` correctly extracts cache-token fields across
Anthropic, OpenAI, and Gemini. Fires real provider calls and prints both the
raw provider `usage` block and the normalized `tokens` field for each run, so
discrepancies are visually obvious.

## Setup

```bash
cp .env.example .env
# fill in the API keys for whichever providers you want to test
npm install
```

## Run

```bash
# Anthropic — explicit cache_control on a large system prompt
npm run start -- --provider anthropic --runs 2 --cache-mode explicit

# OpenAI — automatic caching (Responses API)
npm run start -- --provider openai --runs 2 --prompt-size large

# Gemini — implicit caching on a long prompt
npm run start -- --provider gemini --runs 2 --prompt-size large
```

## Flags

| Flag | Values | Default | Notes |
|---|---|---|---|
| `--provider` | `anthropic` \| `openai` \| `gemini` | *(required)* | |
| `--model` | model ID | per-provider default | Defaults: `claude-haiku-4-5`, `gpt-5.4-nano`, `gemini-3.5-flash`. All defaults are invoked at minimum reasoning effort (OpenAI `reasoning.effort=minimal`; Gemini `thinkingBudget=0`; Anthropic extended thinking left off). |
| `--runs` | integer ≥ 1 | `2` | First call typically misses; later calls hit |
| `--prompt-size` | `small` \| `large` | `large` | `large` pads the system prompt to ~6 KB so all providers' cache thresholds are crossed |
| `--cache-mode` | `auto` \| `explicit` \| `off` | `auto` | `explicit` only meaningful for Anthropic (adds `cache_control` marker); OpenAI is always automatic; Gemini "auto" uses implicit caching |
| `--ttl` | `5m` \| `1h` | `5m` | Anthropic only |

## What to expect

First call: cache miss — `cached=0`; for Anthropic with `--cache-mode explicit` you should also see `cacheCreation>0` indicating tokens were written to cache.

Second call (same prefix, within TTL): cache hit — `cached>0`. The normalized `cached` value should equal the raw provider field:

- Anthropic: `usage.cache_read_input_tokens`
- OpenAI: `usage.input_tokens_details.cached_tokens` (Responses API) or `usage.prompt_tokens_details.cached_tokens` (Chat Completions)
- Gemini: `usageMetadata.cachedContentTokenCount`

Gemini implicit caching is best-effort and may not fire on every run — if `cached=0` on the second call, increase `--prompt-size` or try an explicitly-cached prefix.
