# llmvantage — monorepo

Repository for the [`llmvantage`](packages/llmvantage/README.md) package: a lightweight, zero-dependency observability layer for LLM API calls in TypeScript/Node.js.

> **Using the library?** Start at [`packages/llmvantage/README.md`](packages/llmvantage/README.md) — that's the user-facing documentation and the canonical npm page.
>
> **Working on the library?** You're in the right place. Read on.

## Quick start (for contributors)

```bash
git clone https://github.com/frandi/llmvantage.git
cd llmvantage
npm install           # installs every workspace under packages/* and demos/*
npm test              # runs the test suite for packages/llmvantage
npm run typecheck     # tsc --noEmit
npm run build         # emits dist/esm + dist/cjs under packages/llmvantage
```

Node.js **18+** is required (the fetch patch relies on `response.body.tee()`).

## Repo layout

```
llmvantage/
├── packages/llmvantage/          # the publishable package
│   ├── src/
│   │   ├── core.ts               # observer + fetch patch
│   │   ├── types.ts              # LLMEvent, Plugin, Sink, ObserverError, ...
│   │   ├── providers.ts          # hostname filter (Anthropic/OpenAI/Gemini)
│   │   ├── buffer.ts             # createBuffer — batched delivery + drain
│   │   ├── plugins/
│   │   │   ├── normalize-tokens.ts
│   │   │   ├── redact-pii.ts
│   │   │   └── README.md
│   │   └── sinks/
│   │       ├── console.ts
│   │       ├── ndjson-file.ts
│   │       ├── http.ts
│   │       └── README.md
│   ├── test/                     # node:test + assert/strict
│   ├── scripts/fixup-dist.mjs    # post-build ESM/CJS package.json shims
│   └── README.md                 # ← user-facing docs (npm page)
├── demos/
│   ├── 01-esm/                   # TypeScript ESM — Anthropic + Gemini
│   ├── 02-cjs/                   # CommonJS       — OpenAI Responses API
│   ├── 03-buffer/                # createBuffer   — batching + graceful drain
│   └── 04-cache/                 # Cache tokens   — Anthropic / OpenAI / Gemini validation
└── docs/
    ├── llmvantage-spec.md        # full specification
    └── llmvantage-spec.docx
```

## Working on the code

### Daily loop

```bash
npm test               # full suite, ~0.5 s
npm run typecheck      # strict mode, no emit
npm run build          # dual-build ESM + CJS + subpath exports
```

Tests live at [`packages/llmvantage/test/*.test.ts`](packages/llmvantage/test). They use `node:test` + `assert/strict` directly (no Jest, Vitest, or ts-jest) — run via `tsx`. The pattern is: `beforeEach(__internal.reset)` to clear observer state between tests, then exercise the pipeline via `__internal.runPipeline(event)` which bypasses the fetch patch.

### Authoring plugins

Plugins are `(event: LLMEvent) => LLMEvent | Promise<LLMEvent>`. See [`packages/llmvantage/src/plugins/README.md`](packages/llmvantage/src/plugins/README.md) for the compliance-boundary contract, the tree-walker pattern used by `redactPii`, and extensibility notes (e.g. `PII_PATTERNS` is a mutable export).

### Authoring sinks

Sinks are `(event: LLMEvent) => void | Promise<void>`. See [`packages/llmvantage/src/sinks/README.md`](packages/llmvantage/src/sinks/README.md) for composition patterns (retry, timeout, rotation, batching via `createBuffer`) and the shutdown contract.

### Running the demos

Each demo is its own workspace. From the repo root:

```bash
cp demos/01-esm/.env.example demos/01-esm/.env   # fill in API keys
npm start -w demo-01-esm                          # tsx index.ts

cp demos/03-buffer/.env.example demos/03-buffer/.env
npm start -w demo-03-buffer                       # buffered burst + drain
```

The demos share the top-level `node_modules` via npm workspaces — no per-demo install step.

## The compliance boundary (why it matters)

`observer.use(plugin)` must come before `observer.pipe(sink)`. Once any sink is registered, further `use()` calls throw. This makes the plugin chain the **single** enforcement point for redaction, filtering, and policy: every sink — every collector, every dashboard, every alert pipeline — can treat its input as already compliant.

The spec calls this the *compliance boundary*. It's the architectural reason the library exists.

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

## Spec

The full specification lives at [`docs/llmvantage-spec.md`](docs/llmvantage-spec.md) (a rendered `.docx` is checked in alongside). When behaviour and spec disagree, the spec is authoritative — file an issue.

## Contributing

1. Read the spec section relevant to your change.
2. Add tests first — existing tests in `packages/llmvantage/test/` are the fastest way to see the testing style.
3. `npm run typecheck && npm test` must pass.
4. New plugins/sinks need a README entry (`plugins/README.md` or `sinks/README.md`) and — if they have a public API surface — a subpath export in `packages/llmvantage/package.json`.

## License

MIT
