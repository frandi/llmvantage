export type Provider = "anthropic" | "openai" | "gemini" | "unknown";

export type EventSource = "fetch" | "manual";

export type LLMEvent = {
  schemaVersion: string;
  source: EventSource;
  provider: Provider;
  endpoint: string;
  request: unknown;
  response: unknown;
  latencyMs: number;
  timestamp: string;
  streaming: boolean;
};

export type Plugin = (event: LLMEvent) => LLMEvent | Promise<LLMEvent>;

export type Sink = (event: LLMEvent) => void | Promise<void>;

export type ObserverErrorPhase = "plugin" | "sink" | "stream";

export type ObserverError = {
  phase: ObserverErrorPhase;
  error: Error;
  event?: Partial<LLMEvent>;
};

export type ErrorHandler = (err: ObserverError) => void;
