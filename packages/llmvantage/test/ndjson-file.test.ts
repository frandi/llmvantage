import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileSink, __internal as fileInternal } from "../src/sinks/ndjson-file.js";
import type { LLMEvent, Provider } from "../src/types.js";

const event = (overrides: Partial<LLMEvent> = {}): LLMEvent => ({
  schemaVersion: "1.1",
  source: "manual",
  provider: "anthropic" as Provider,
  endpoint: "/v1/messages",
  request: { model: "claude-sonnet-4-5" },
  response: { id: "msg_1" },
  latencyMs: 42,
  timestamp: "2026-04-21T00:00:00.000Z",
  streaming: false,
  ...overrides,
});

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llmvantage-"));
});

afterEach(async () => {
  await fileInternal.drainAll();
  rmSync(dir, { recursive: true, force: true });
});

describe("fileSink", () => {
  test("appends NDJSON lines — one per event, each round-trips", async () => {
    const path = join(dir, "events.ndjson");
    const sink = fileSink(path);

    const e1 = event({ endpoint: "/v1/messages" });
    const e2 = event({ endpoint: "/v1/messages/count_tokens", latencyMs: 7 });
    sink(e1);
    sink(e2);

    await fileInternal.drainAll();

    const raw = readFileSync(path, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0]!), e1);
    assert.deepEqual(JSON.parse(lines[1]!), e2);
  });

  test("preserves non-ASCII unicode content", async () => {
    const path = join(dir, "unicode.ndjson");
    const sink = fileSink(path);
    const e = event({
      request: { prompt: "こんにちは 👋 — émoji test ∑∆" },
    });
    sink(e);

    await fileInternal.drainAll();

    const line = readFileSync(path, "utf8").trim();
    const parsed = JSON.parse(line) as LLMEvent;
    assert.equal(
      (parsed.request as { prompt: string }).prompt,
      "こんにちは 👋 — émoji test ∑∆"
    );
  });

  test("two sinks at different paths write to separate files", async () => {
    const p1 = join(dir, "a.ndjson");
    const p2 = join(dir, "b.ndjson");
    const s1 = fileSink(p1);
    const s2 = fileSink(p2);

    const eA = event({ endpoint: "/A" });
    const eB = event({ endpoint: "/B" });
    s1(eA);
    s2(eB);

    await fileInternal.drainAll();

    const aLines = readFileSync(p1, "utf8").split("\n").filter(Boolean);
    const bLines = readFileSync(p2, "utf8").split("\n").filter(Boolean);
    assert.equal(aLines.length, 1);
    assert.equal(bLines.length, 1);
    assert.equal((JSON.parse(aLines[0]!) as LLMEvent).endpoint, "/A");
    assert.equal((JSON.parse(bLines[0]!) as LLMEvent).endpoint, "/B");
  });
});
