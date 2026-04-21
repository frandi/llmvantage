import { getOriginalFetch } from "../core.js";
import type { LLMEvent, Sink } from "../types.js";

export const httpSink = (
  url: string,
  headers: Record<string, string> = {}
): Sink =>
  async (event: LLMEvent): Promise<void> => {
    const res = await getOriginalFetch()(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(event),
    });
    if (!res.ok) {
      throw new Error(`httpSink: ${res.status} ${res.statusText}`);
    }
  };
