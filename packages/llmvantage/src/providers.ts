import type { Provider } from "./types.js";

const HOSTS: Record<string, Provider> = {
  "api.anthropic.com": "anthropic",
  "api.openai.com": "openai",
  "generativelanguage.googleapis.com": "gemini",
};

export function isLLMHost(url: string): boolean {
  const host = hostnameOf(url);
  return host !== null && host in HOSTS;
}

export function detectProvider(url: string): Provider {
  const host = hostnameOf(url);
  return (host && HOSTS[host]) || "unknown";
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
