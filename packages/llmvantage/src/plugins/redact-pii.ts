import type { Plugin } from "../types.js";

export type PiiPattern = { pattern: RegExp; replacement: string };

export const PII_PATTERNS: PiiPattern[] = [
  {
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replacement: "[EMAIL]",
  },
  {
    pattern: /(?<!\w)(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}(?!\w)/g,
    replacement: "[PHONE]",
  },
  {
    pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    replacement: "[API_KEY]",
  },
];

export const redactPii: Plugin = (event) => ({
  ...event,
  request: redactValue(event.request),
  response: redactValue(event.response),
});

function redactValue(v: unknown): unknown {
  if (typeof v === "string") return redactString(v);
  if (Array.isArray(v)) return redactArray(v);
  if (v !== null && typeof v === "object" && isPlainObject(v)) {
    return redactObject(v as Record<string, unknown>);
  }
  return v;
}

function redactString(s: string): string {
  let out = s;
  for (const { pattern, replacement } of PII_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function redactArray(a: unknown[]): unknown[] {
  let changed = false;
  const next: unknown[] = new Array(a.length);
  for (let i = 0; i < a.length; i++) {
    const child = a[i];
    const redacted = redactValue(child);
    if (redacted !== child) changed = true;
    next[i] = redacted;
  }
  return changed ? next : a;
}

function redactObject(o: Record<string, unknown>): Record<string, unknown> {
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const key of Object.keys(o)) {
    const child = o[key];
    const redacted = redactValue(child);
    if (redacted !== child) changed = true;
    next[key] = redacted;
  }
  return changed ? next : o;
}

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
