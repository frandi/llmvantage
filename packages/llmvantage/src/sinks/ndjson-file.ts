import { createWriteStream, type WriteStream } from "node:fs";
import type { LLMEvent, Sink } from "../types.js";

const activeStreams = new Set<WriteStream>();
let beforeExitRegistered = false;

function registerBeforeExit(): void {
  if (beforeExitRegistered) return;
  beforeExitRegistered = true;
  process.once("beforeExit", () => {
    for (const s of activeStreams) s.end();
  });
}

export const fileSink = (path: string): Sink => {
  const stream = createWriteStream(path, { flags: "a" });
  stream.on("error", (err) => {
    // Async stream errors cannot route to observer.onError — the sink's
    // synchronous return has already completed. Best-effort stderr log.
    console.error("[llmvantage] fileSink:", (err as Error).message);
  });
  stream.on("close", () => activeStreams.delete(stream));
  activeStreams.add(stream);
  registerBeforeExit();

  return (event: LLMEvent): void => {
    stream.write(JSON.stringify(event) + "\n");
  };
};

export const __internal = {
  async drainAll(): Promise<void> {
    const streams = [...activeStreams];
    await Promise.all(
      streams.map(
        (s) => new Promise<void>((resolve) => s.end(() => resolve()))
      )
    );
  },
};
