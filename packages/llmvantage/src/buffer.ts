import type { LLMEvent } from "./types.js";

/**
 * Handler invoked with each batch dequeued from the buffer.
 *
 * Throwing (or rejecting) routes the batch to {@link BufferOptions.onError}.
 * The drain loop survives a handler failure — subsequent batches still fire.
 */
export type DrainHandler = (batch: LLMEvent[]) => Promise<void> | void;

/**
 * Policy applied when `enqueue` is called while the queue is at `maxQueueSize`.
 *
 * - `"oldest"` (default): shift the head and enqueue the new event. Telemetry-
 *   appropriate — under a collector stall the most recent events are more
 *   actionable than ones that arrived 30 s ago.
 * - `"newest"`: reject the incoming event; queue is unchanged. Better for work
 *   queues and network protocols where already-accepted work must be honored.
 */
export type DropPolicy = "oldest" | "newest";

export type BufferOptions = {
  /** Interval (ms) between drain ticks. Default: 100. */
  flushInterval?: number;
  /** Maximum events delivered in one `handler` call. Default: 20. */
  batchSize?: number;
  /** Maximum in-memory queue depth before `dropPolicy` kicks in. Default: 10_000. */
  maxQueueSize?: number;
  /** Behavior when the queue is full. Default: `"oldest"`. */
  dropPolicy?: DropPolicy;
  /**
   * When `true` (default), the buffer participates in a single global
   * `beforeExit` / `SIGTERM` handler that drains every active buffer before
   * the process exits. When `false`, the user owns shutdown via explicit
   * `await buf.flush()`.
   */
  handleSignals?: boolean;
  /** Invoked when `handler` throws or rejects. The batch is already removed from the queue. */
  onError?: (err: Error, batch: LLMEvent[]) => void;
  /** Invoked whenever an event is dropped due to `maxQueueSize`. */
  onDrop?: (event: LLMEvent) => void;
};

export type Buffer = {
  /** Enqueue one event. Matches the `Sink` signature — usable with `observer.pipe(buf.enqueue)`. */
  enqueue: (event: LLMEvent) => void;
  /** Drain the queue to empty, stop the interval, and resolve. Concurrent-safe and idempotent. */
  flush: () => Promise<void>;
  /** Current queue depth. */
  readonly depth: number;
};

// ---------------------------------------------------------------------------
// Module-level shutdown registry
//
// A single `beforeExit` + `SIGTERM` pair covers every active buffer, no matter
// how many `createBuffer` calls happen. Handler refs are retained so the test
// `__internal.reset()` hook can `removeListener` them between runs.
// ---------------------------------------------------------------------------

const activeBuffers = new Set<Buffer>();
let shutdownRegistered = false;
let beforeExitHandler: (() => void) | null = null;
let sigTermHandler: (() => void) | null = null;

function registerShutdown(): void {
  if (shutdownRegistered) return;
  shutdownRegistered = true;
  const drainAll = (): Promise<unknown> =>
    Promise.all([...activeBuffers].map((b) => b.flush()));
  beforeExitHandler = () => {
    void drainAll();
  };
  sigTermHandler = () => {
    void drainAll().then(() => process.exit(0));
  };
  process.once("beforeExit", beforeExitHandler);
  process.once("SIGTERM", sigTermHandler);
}

/**
 * In-memory bounded queue + interval-flushed batching primitive.
 *
 * Decouples the observer pipeline from sinks: events are enqueued in O(1)
 * and delivered in batches to `handler` every `flushInterval` ms (one batch
 * per tick to avoid blocking the event loop during bursts).
 *
 * `buf.enqueue` matches the `Sink` signature exactly — wire it via
 * `observer.pipe(buf.enqueue)` without an adapter.
 */
export function createBuffer(
  handler: DrainHandler,
  opts: BufferOptions = {}
): Buffer {
  const flushInterval = opts.flushInterval ?? 100;
  const batchSize = opts.batchSize ?? 20;
  const maxQueueSize = opts.maxQueueSize ?? 10_000;
  const dropPolicy: DropPolicy = opts.dropPolicy ?? "oldest";
  const handleSignals = opts.handleSignals ?? true;

  const queue: LLMEvent[] = [];
  let inFlight: Promise<void> | null = null;
  let flushPromise: Promise<void> | null = null;

  const enqueue = (event: LLMEvent): void => {
    if (queue.length >= maxQueueSize) {
      if (dropPolicy === "oldest") {
        const shifted = queue.shift()!;
        queue.push(event);
        opts.onDrop?.(shifted);
      } else {
        opts.onDrop?.(event);
      }
      return;
    }
    queue.push(event);
  };

  const drain = (): void => {
    if (inFlight || queue.length === 0) return;
    inFlight = (async () => {
      try {
        const batch = queue.splice(0, batchSize);
        try {
          await handler(batch);
        } catch (err) {
          opts.onError?.(err as Error, batch);
        }
      } finally {
        inFlight = null;
      }
    })();
  };

  const interval = setInterval(drain, flushInterval);
  // Don't pin the process open — `beforeExit` fires on clean shutdown and
  // drains everything via the global handler below.
  interval.unref();

  const flush = (): Promise<void> => {
    if (flushPromise) return flushPromise;
    flushPromise = (async () => {
      try {
        clearInterval(interval);
        while (inFlight) await inFlight;
        while (queue.length > 0) {
          const batch = queue.splice(0, batchSize);
          try {
            await handler(batch);
          } catch (err) {
            opts.onError?.(err as Error, batch);
          }
        }
      } finally {
        flushPromise = null;
      }
    })();
    return flushPromise;
  };

  const buf: Buffer = {
    enqueue,
    flush,
    get depth(): number {
      return queue.length;
    },
  };

  if (handleSignals) {
    registerShutdown();
    activeBuffers.add(buf);
  }

  return buf;
}

/**
 * Test-only hook. Removes the global `beforeExit` / `SIGTERM` listeners and
 * clears the active-buffer registry so suite-level state doesn't leak across
 * tests. Mirrors the pattern in `core.ts`.
 */
export const __internal = {
  reset(): void {
    if (beforeExitHandler) {
      process.removeListener("beforeExit", beforeExitHandler);
    }
    if (sigTermHandler) {
      process.removeListener("SIGTERM", sigTermHandler);
    }
    beforeExitHandler = null;
    sigTermHandler = null;
    shutdownRegistered = false;
    activeBuffers.clear();
  },
};
