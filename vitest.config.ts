import { defineConfig } from "vitest/config";

// Live test file is only included when AR_LIVE_TEST=1. Otherwise it's excluded
// so default `vitest run` stays offline and deterministic.
const EXCLUDE = ["node_modules", "dist"];
if (process.env.AR_LIVE_TEST !== "1") {
  EXCLUDE.push("test/live.test.ts");
}

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: EXCLUDE,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
    },
  },
});
