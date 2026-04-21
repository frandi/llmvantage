// Writes per-directory package.json files so Node treats each output
// directory with the correct module type regardless of the root package
// `type` field. Runs after both tsc builds complete.
import { writeFileSync } from "node:fs";

writeFileSync(
  "dist/esm/package.json",
  JSON.stringify({ type: "module" }, null, 2) + "\n"
);
writeFileSync(
  "dist/cjs/package.json",
  JSON.stringify({ type: "commonjs" }, null, 2) + "\n"
);
