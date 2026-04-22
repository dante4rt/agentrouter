import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import claudeFixture from "../fixtures/claude-response.json" assert { type: "json" };
import deepseekFixture from "../fixtures/deepseek-response.json" assert { type: "json" };
import noChannelFixture from "../fixtures/error-no-channel.json" assert { type: "json" };
import unauthorizedClientFixture from "../fixtures/error-unauthorized-client.json" assert {
  type: "json",
};
import glmFixture from "../fixtures/glm-reasoning-response.json" assert { type: "json" };
import { AgentRouter } from "../src/client.js";
import {
  AgentRouterError,
  AuthError,
  NoChannelError,
  RateLimitError,
  TimeoutError,
  UnauthorizedClientError,
} from "../src/errors.js";
import { DEFAULT_MODEL, KNOWN_MODELS } from "../src/models.js";

// ---------------------------------------------------------------------------
// MSW server setup
// ---------------------------------------------------------------------------

const BASE = "https://agentrouter.org/v1";
const PATH = "/chat/completions";

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAr(
  overrides: Partial<ConstructorParameters<typeof AgentRouter>[0]> = {}
): AgentRouter {
  return new AgentRouter({ apiKey: "test-key", ...overrides });
}

function respondWith(body: unknown, status = 200): ReturnType<typeof http.post> {
  return http.post(`${BASE}${PATH}`, () => HttpResponse.json(body, { status }));
}

function respondWithText(text: string, status = 200): ReturnType<typeof http.post> {
  return http.post(
    `${BASE}${PATH}`,
    () => new HttpResponse(text, { status, headers: { "content-type": "application/json" } })
  );
}

// ---------------------------------------------------------------------------
// Constructor validation
// ---------------------------------------------------------------------------

describe("AgentRouter constructor", () => {
  it("should throw TypeError when apiKey is missing", () => {
    expect(() => new AgentRouter({ apiKey: "" })).toThrow(TypeError);
  });

  it("should throw TypeError when apiKey is whitespace-only", () => {
    expect(() => new AgentRouter({ apiKey: "   " })).toThrow(TypeError);
  });

  it("should not throw when apiKey is provided", () => {
    expect(() => makeAr()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Static properties
// ---------------------------------------------------------------------------

describe("AgentRouter.models", () => {
  it("should equal the KNOWN_MODELS list from models.ts", () => {
    expect(AgentRouter.models).toEqual(KNOWN_MODELS);
  });

  it("should include the default model", () => {
    expect(AgentRouter.models).toContain(DEFAULT_MODEL);
  });
});

// ---------------------------------------------------------------------------
// chat() — happy path
// ---------------------------------------------------------------------------

describe("AgentRouter.chat — happy path", () => {
  it("should return content string from a plain-object response (DeepSeek)", async () => {
    server.use(respondWith(deepseekFixture));

    const ar = makeAr();
    const result = await ar.chat("hi");

    expect(result).toBe("The answer is 42.");
  });

  it("should unwrap double-encoded Claude response and return content string", async () => {
    // claudeFixture is itself a JSON string (top-level string containing JSON).
    // Transport.request does the double-decode; we serve the raw fixture content
    // as a JSON string literal so the mock mimics what the real API returns.
    server.use(respondWithText(JSON.stringify(claudeFixture)));

    const ar = makeAr();
    const result = await ar.chat("hello");

    expect(result).toBe("Hello! How can I assist you today?");
  });

  it("should return empty string and call debug callback when reasoning-only response", async () => {
    server.use(respondWith(glmFixture));

    const debug = vi.fn<[string], void>();
    const ar = makeAr({ model: "glm-4.5", debug });

    const result = await ar.chat("2+2?");

    expect(result).toBe("");
    // Transport calls debug twice per request (request_start + response_status).
    // chat() adds one more call for the reasoning-only warning. Total: 3.
    expect(debug).toHaveBeenCalledTimes(3);
    // The reasoning warning is the last call.
    const lastCall = debug.mock.calls[debug.mock.calls.length - 1];
    expect(lastCall?.[0]).toContain("reasoning");
  });
});

// ---------------------------------------------------------------------------
// complete() — CompletionResult shape
// ---------------------------------------------------------------------------

describe("AgentRouter.complete — result mapping", () => {
  it("should return full CompletionResult with all fields populated (DeepSeek)", async () => {
    server.use(respondWith(deepseekFixture));

    const ar = makeAr();
    const result = await ar.complete({ messages: [{ role: "user", content: "test" }] });

    expect(result.content).toBe("The answer is 42.");
    expect(result.reasoning).toBeUndefined();
    expect(result.model).toBe("deepseek-v3.2");
    expect(result.finishReason).toBe("stop");
    expect(result.usage.promptTokens).toBe(15);
    expect(result.usage.completionTokens).toBe(5);
    expect(result.usage.totalTokens).toBe(20);
    expect(result.raw).toBeDefined();
  });

  it("should populate reasoning field from glm reasoning-only response", async () => {
    server.use(respondWith(glmFixture));

    const ar = makeAr({ model: "glm-4.5" });
    const result = await ar.complete({ messages: [{ role: "user", content: "think" }] });

    expect(result.content).toBe("");
    expect(result.reasoning).toContain("Let me think about this");
    expect(result.usage.completionTokens).toBeGreaterThan(0);
  });

  it("should use fallback model from resolved options when response omits model field", async () => {
    const withoutModel = { ...deepseekFixture, model: undefined };
    server.use(respondWith(withoutModel));

    const ar = makeAr({ model: "deepseek-v3.1" });
    const result = await ar.complete({ messages: [{ role: "user", content: "hi" }] });

    expect(result.model).toBe("deepseek-v3.1");
  });

  it("should use model override from per-request options", async () => {
    server.use(respondWith(deepseekFixture));

    const ar = makeAr();
    const result = await ar.complete({
      messages: [{ role: "user", content: "hi" }],
      model: "deepseek-v3.2",
    });

    // Model in response wins; fallback only when response omits model.
    expect(result.model).toBe("deepseek-v3.2");
  });
});

// ---------------------------------------------------------------------------
// Error response handling
// ---------------------------------------------------------------------------

describe("AgentRouter.chat — malformed response", () => {
  it("should throw AgentRouterError when choices array is empty", async () => {
    server.use(respondWith({ id: "x", model: "m", choices: [], usage: { prompt_tokens: 0 } }));

    const ar = makeAr();

    await expect(ar.chat("hi")).rejects.toBeInstanceOf(AgentRouterError);
  });

  it("should throw AgentRouterError when choices field is missing", async () => {
    server.use(respondWith({ id: "x", model: "m" }));

    const ar = makeAr();

    await expect(ar.chat("hi")).rejects.toBeInstanceOf(AgentRouterError);
  });
});

describe("AgentRouter.chat — HTTP error classification", () => {
  it("should throw UnauthorizedClientError on 401 with unauthorized-client body", async () => {
    server.use(respondWith(unauthorizedClientFixture, 401));

    const ar = makeAr();

    await expect(ar.chat("hi")).rejects.toBeInstanceOf(UnauthorizedClientError);
  });

  it("should throw AuthError on 401 without unauthorized-client marker", async () => {
    server.use(
      respondWith({ error: { message: "invalid api key", type: "authentication_error" } }, 401)
    );

    const ar = makeAr();

    await expect(ar.chat("hi")).rejects.toBeInstanceOf(AuthError);
  });

  it("should throw NoChannelError on 503 with the no-channel marker", async () => {
    server.use(respondWith(noChannelFixture, 503));

    const ar = makeAr({ model: "claude-opus-4-6" });

    await expect(ar.chat("hi")).rejects.toSatisfy((e: unknown) => {
      return e instanceof NoChannelError && e.model === "claude-opus-4-6";
    });
  });

  it("should throw generic AgentRouterError on bare 503 without the marker", async () => {
    server.use(respondWith({ error: "Service unavailable" }, 503));

    const ar = makeAr({ model: "claude-opus-4-6" });

    await expect(ar.chat("hi")).rejects.toSatisfy((e: unknown) => {
      return e instanceof AgentRouterError && !(e instanceof NoChannelError) && e.status === 503;
    });
  });

  it("should throw NoChannelError when body contains Chinese no-channel marker on non-2xx status", async () => {
    // classifyError is only called on !response.ok responses. The no-channel marker
    // in the body must arrive with a non-2xx status to be classified.
    server.use(respondWith(noChannelFixture, 503));

    const ar = makeAr({ model: "glm-4.5" });

    await expect(ar.chat("hi")).rejects.toBeInstanceOf(NoChannelError);
  });

  it("should throw RateLimitError on 429 with retryAfter from header", async () => {
    server.use(
      http.post(`${BASE}${PATH}`, () =>
        HttpResponse.json(
          { error: "rate limited" },
          { status: 429, headers: { "retry-after": "10" } }
        )
      )
    );

    const ar = makeAr();

    await expect(ar.chat("hi")).rejects.toSatisfy((e: unknown) => {
      return e instanceof RateLimitError && e.retryAfter === 10;
    });
  });
});

// ---------------------------------------------------------------------------
// Stainless / request headers
// ---------------------------------------------------------------------------

describe("AgentRouter — outgoing request headers", () => {
  it("should send Authorization as Bearer <key>", async () => {
    let capturedAuth: string | null = null;

    server.use(
      http.post(`${BASE}${PATH}`, ({ request }) => {
        capturedAuth = request.headers.get("authorization");
        return HttpResponse.json(deepseekFixture);
      })
    );

    await makeAr({ apiKey: "sk-test-abc" }).chat("hi");

    expect(capturedAuth).toBe("Bearer sk-test-abc");
  });

  it("should send x-stainless-lang header set to js", async () => {
    let capturedLang: string | null = null;

    server.use(
      http.post(`${BASE}${PATH}`, ({ request }) => {
        capturedLang = request.headers.get("x-stainless-lang");
        return HttpResponse.json(deepseekFixture);
      })
    );

    await makeAr().chat("hi");

    expect(capturedLang).toBe("js");
  });

  it("should send x-stainless-package-version header", async () => {
    let capturedVersion: string | null = null;

    server.use(
      http.post(`${BASE}${PATH}`, ({ request }) => {
        capturedVersion = request.headers.get("x-stainless-package-version");
        return HttpResponse.json(deepseekFixture);
      })
    );

    await makeAr().chat("hi");

    expect(capturedVersion).toBe("6.34.0");
  });

  it("should send user-agent with default value when not overridden", async () => {
    let capturedUA: string | null = null;

    server.use(
      http.post(`${BASE}${PATH}`, ({ request }) => {
        capturedUA = request.headers.get("user-agent");
        return HttpResponse.json(deepseekFixture);
      })
    );

    await makeAr().chat("hi");

    expect(capturedUA).toBeTruthy();
    expect(typeof capturedUA).toBe("string");
  });

  it("should redact Authorization in debug callback output — never expose raw key", async () => {
    server.use(respondWith(deepseekFixture));

    const debugMessages: string[] = [];
    const ar = makeAr({
      apiKey: "sk-super-secret",
      debug: (msg) => debugMessages.push(msg),
    });

    await ar.chat("hi");

    const allOutput = debugMessages.join("\n");
    expect(allOutput).not.toContain("sk-super-secret");
    // Redacted form should appear instead.
    expect(allOutput).toContain("REDACTED");
  });
});

// ---------------------------------------------------------------------------
// Default option resolution
// ---------------------------------------------------------------------------

describe("AgentRouter — default option resolution", () => {
  it("should use claude-opus-4-7 as default model when none specified", async () => {
    let requestBody: Record<string, unknown> = {};

    server.use(
      http.post(`${BASE}${PATH}`, async ({ request }) => {
        requestBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(deepseekFixture);
      })
    );

    await makeAr().chat("hi");

    expect(requestBody.model).toBe("claude-opus-4-7");
  });

  it("should use 1024 as default maxTokens when none specified", async () => {
    let requestBody: Record<string, unknown> = {};

    server.use(
      http.post(`${BASE}${PATH}`, async ({ request }) => {
        requestBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(deepseekFixture);
      })
    );

    await makeAr().chat("hi");

    expect(requestBody.max_tokens).toBe(1024);
  });

  it("should use custom baseURL when provided", async () => {
    const CUSTOM = "https://custom.example.com/v1";

    server.use(http.post(`${CUSTOM}${PATH}`, () => HttpResponse.json(deepseekFixture)));

    const ar = new AgentRouter({ apiKey: "k", baseURL: CUSTOM });
    // No error means the request reached the custom base URL.
    await expect(ar.chat("hi")).resolves.toBe("The answer is 42.");
  });

  it("should use custom maxTokens when provided via constructor", async () => {
    let requestBody: Record<string, unknown> = {};

    server.use(
      http.post(`${BASE}${PATH}`, async ({ request }) => {
        requestBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(deepseekFixture);
      })
    );

    await makeAr({ maxTokens: 2048 }).chat("hi");

    expect(requestBody.max_tokens).toBe(2048);
  });
});

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

describe("AgentRouter — timeout", () => {
  it("should throw TimeoutError when upstream does not respond within timeout", async () => {
    server.use(
      http.post(`${BASE}${PATH}`, async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return HttpResponse.json(deepseekFixture);
      })
    );

    const ar = makeAr({ timeout: 50 });

    await expect(ar.chat("hi")).rejects.toBeInstanceOf(TimeoutError);
  }, 5000);
});
