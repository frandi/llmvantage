import "dotenv/config";
import "llmvantage";
import { observer } from "llmvantage";
import { normalizeTokens } from "llmvantage/plugins/normalize-tokens";
import { consoleSink } from "llmvantage/sinks/console";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";

observer
  .use(normalizeTokens)
  .pipe(consoleSink)
  .onError((err) => console.warn("[llmvantage]", err.phase, err.error.message));

// --- Anthropic ---
const anthropic = new Anthropic();
const msg = await anthropic.messages.create({
  model: "claude-haiku-4-5",
  max_tokens: 128,
  messages: [{ role: "user", content: "Say 'I love ESM' in three languages." }],
});
console.log("anthropic:", JSON.stringify(msg.content));

// --- Gemini ---
const gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const response = await gemini.models.generateContent({
  model: "gemini-3.1-flash-lite-preview",
  contents: "Say 'I love ESM' in three languages.",
});
console.log("gemini:", response.text);
