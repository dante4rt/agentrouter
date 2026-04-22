import { describe, expect, it } from "vitest";
import { AgentRouter } from "../src/index.js";

const RUN = process.env.AR_LIVE_TEST === "1";
const KEY = process.env.AR_API_KEY ?? "";

describe.skipIf(!RUN || !KEY)("live AgentRouter", () => {
  it("completes a short chat on default model", async () => {
    const ar = new AgentRouter({ apiKey: KEY });
    const out = await ar.chat("Respond with exactly the word: ping");
    expect(typeof out).toBe("string");
  }, 60_000);

  it("streams tokens", async () => {
    const ar = new AgentRouter({ apiKey: KEY });
    const chunks: string[] = [];
    for await (const c of ar.stream("count to three")) {
      if (c.type === "content" && c.delta) chunks.push(c.delta);
    }
    expect(chunks.length).toBeGreaterThan(0);
  }, 60_000);
});
