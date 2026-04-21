// index.cjs — must be the first require in your entry point
require("dotenv/config");
require("llmvantage");
const { observer } = require("llmvantage");
const { normalizeTokens } = require("llmvantage/plugins/normalize-tokens");
const { consoleSink } = require("llmvantage/sinks/console");
const OpenAI = require("openai");

observer
  .use(normalizeTokens)
  .pipe(consoleSink)
  .onError((err) => console.warn("[llmvantage]", err.phase, err.error.message));

async function main() {
  const client = new OpenAI();
  const response = await client.responses.create({
    model: "gpt-5.4-nano",
    input: "Say 'I love CJS' in three languages.",
  });
  console.log("response:", response.output_text);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
