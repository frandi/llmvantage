import type {
  ErrorHandler,
  LLMEvent,
  ObserverError,
  Plugin,
  Sink,
} from "./types.js";
import { detectProvider, isLLMHost } from "./providers.js";

type FetchInput = string | URL | Request;

export type IngestInput =
  Omit<LLMEvent, "schemaVersion" | "source" | "timestamp"> & {
    timestamp?: string;
  };

type Observer = {
  use(plugin: Plugin): Observer;
  pipe(sink: Sink): Observer;
  onError(handler: ErrorHandler): Observer;
  ingest(input: IngestInput): Promise<void>;
};

const SCHEMA_VERSION = "1.1";

const plugins: Plugin[] = [];
const sinks: Sink[] = [];
const errorHandlers: ErrorHandler[] = [];
let sinksRegistered = false;
let originalFetch: typeof globalThis.fetch = globalThis.fetch;

function report(err: ObserverError): void {
  for (const h of errorHandlers) {
    try { h(err); } catch { /* no-op: never throw from report */ }
  }
}

async function runPipeline(event: LLMEvent): Promise<void> {
  let current = event;
  for (const plugin of plugins) {
    try {
      current = await plugin(current);
    } catch (error) {
      report({ phase: "plugin", error: error as Error, event: current });
      return;
    }
  }
  await Promise.all(
    sinks.map((sink) =>
      Promise.resolve()
        .then(() => sink(current))
        .catch((error) => report({ phase: "sink", error: error as Error, event: current }))
    )
  );
}

async function patchedFetch(input: FetchInput, init?: RequestInit): Promise<Response> {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!isLLMHost(url)) return originalFetch(input, init);

  const t0 = performance.now();
  const endpoint = new URL(url).pathname;
  const provider = detectProvider(url);
  const request = await readRequestBody(input, init);

  const response = await originalFetch(input, init);
  const streaming = (response.headers.get("content-type") ?? "").includes("text/event-stream");

  if (!response.body) {
    setImmediate(() => {
      runPipeline({
        schemaVersion: SCHEMA_VERSION,
        source: "fetch",
        provider, endpoint, request,
        response: undefined,
        latencyMs: performance.now() - t0,
        timestamp: new Date().toISOString(),
        streaming,
      }).catch((error) => report({ phase: "stream", error: error as Error }));
    });
    return response;
  }

  const [sdkStream, observerStream] = response.body.tee();
  setImmediate(async () => {
    try {
      const text = await new Response(observerStream).text();
      const body = streaming ? text : safeParseJson(text);
      await runPipeline({
        schemaVersion: SCHEMA_VERSION,
        source: "fetch",
        provider, endpoint, request,
        response: body,
        latencyMs: performance.now() - t0,
        timestamp: new Date().toISOString(),
        streaming,
      });
    } catch (error) {
      report({ phase: "stream", error: error as Error });
    }
  });

  return new Response(sdkStream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function readRequestBody(input: FetchInput, init?: RequestInit): Promise<unknown> {
  try {
    if (typeof init?.body === "string") return safeParseJson(init.body);
    if (input instanceof Request) return await input.clone().json().catch(() => undefined);
  } catch { /* swallow */ }
  return undefined;
}

function safeParseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

globalThis.fetch = patchedFetch as typeof fetch;

export function getOriginalFetch(): typeof globalThis.fetch {
  return originalFetch;
}

export const observer: Observer = {
  use(plugin) {
    if (sinksRegistered) {
      throw new Error(
        "[llmvantage] observer.use() called after observer.pipe(). Plugins must be registered before sinks."
      );
    }
    plugins.push(plugin);
    return observer;
  },
  pipe(sink) {
    sinksRegistered = true;
    sinks.push(sink);
    return observer;
  },
  onError(handler) {
    errorHandlers.push(handler);
    return observer;
  },
  ingest(input) {
    const event: LLMEvent = {
      schemaVersion: SCHEMA_VERSION,
      source: "manual",
      provider: input.provider,
      endpoint: input.endpoint,
      request: input.request,
      response: input.response,
      latencyMs: input.latencyMs,
      timestamp: input.timestamp ?? new Date().toISOString(),
      streaming: input.streaming,
    };
    return runPipeline(event);
  },
};

export const __internal = {
  reset(): void {
    plugins.length = 0;
    sinks.length = 0;
    errorHandlers.length = 0;
    sinksRegistered = false;
  },
  setOriginalFetch(fn: typeof globalThis.fetch): void {
    originalFetch = fn;
  },
  runPipeline,
};
