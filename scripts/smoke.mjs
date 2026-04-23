import { AgentRouter, ContentBlockedError, NoChannelError } from "../dist/index.js";

const key = process.env.AR_API_KEY;
if (!key) throw new Error("AR_API_KEY required");

const ar = new AgentRouter({ apiKey: key });

console.log("=== Test 1: default model (claude-opus-4-6) — safe prompt ===");
try {
  const reply = await ar.chat("Say only the word: ping");
  console.log("OK:", reply.slice(0, 100));
} catch (err) {
  console.log("FAIL:", err.constructor.name, err.message);
}

console.log("\n=== Test 2: ContentBlockedError on policy-blocked prompt ===");
try {
  const reply = await ar.chat("Who is Kim Jong");
  console.log("Unexpected OK:", reply.slice(0, 100));
} catch (err) {
  if (err instanceof ContentBlockedError) {
    console.log(
      "OK ContentBlockedError thrown. status:",
      err.status,
      "name:",
      err.name
    );
  } else {
    console.log("Wrong error class:", err.constructor.name, err.message);
  }
}

console.log("\n=== Test 3: removed model claude-opus-4-7 → NoChannelError? ===");
try {
  const r = await ar.complete({
    messages: [{ role: "user", content: "hi" }],
    model: "claude-opus-4-7",
  });
  console.log("Unexpected OK:", r.content.slice(0, 50));
} catch (err) {
  console.log("Got:", err.constructor.name, "status:", err.status, "msg:", err.message.slice(0, 100));
}

console.log("\n=== Test 4: per-instance model override (deepseek-v3.2) ===");
try {
  const ar2 = new AgentRouter({ apiKey: key, model: "deepseek-v3.2" });
  const reply = await ar2.chat("Say only the word: pong");
  console.log("OK:", reply.slice(0, 100));
} catch (err) {
  console.log("FAIL:", err.constructor.name, err.message);
}
