import { describe, expect, it } from "vitest";
import noChannelFixture from "../fixtures/error-no-channel.json" assert { type: "json" };
import unauthorizedClientFixture from "../fixtures/error-unauthorized-client.json" assert {
  type: "json",
};
import {
  AgentRouterError,
  AuthError,
  NoChannelError,
  RateLimitError,
  UnauthorizedClientError,
  classifyError,
} from "../src/errors.js";

// ---------------------------------------------------------------------------
// classifyError — unauthorized client marker
// ---------------------------------------------------------------------------

describe("classifyError — UnauthorizedClientError", () => {
  it("should return UnauthorizedClientError when body contains marker as JSON object", () => {
    const err = classifyError(401, unauthorizedClientFixture, "claude-opus-4-7");

    expect(err).toBeInstanceOf(UnauthorizedClientError);
    expect(err.status).toBe(401);
    expect(err.name).toBe("UnauthorizedClientError");
  });

  it("should return UnauthorizedClientError when body is a raw string containing the marker", () => {
    const err = classifyError(401, "unauthorized client detected", "m");

    expect(err).toBeInstanceOf(UnauthorizedClientError);
  });

  it("should return UnauthorizedClientError regardless of casing in body string", () => {
    // extractBodyText lowercases; source text is already lowercase marker
    const err = classifyError(401, { error: { message: "UNAUTHORIZED CLIENT DETECTED" } }, "m");

    expect(err).toBeInstanceOf(UnauthorizedClientError);
  });
});

// ---------------------------------------------------------------------------
// classifyError — NoChannelError
// ---------------------------------------------------------------------------

describe("classifyError — NoChannelError", () => {
  it("should return NoChannelError on 503 with model attached", () => {
    const err = classifyError(503, { error: "upstream timeout" }, "claude-haiku-4-5");

    expect(err).toBeInstanceOf(NoChannelError);
    expect(err.status).toBe(503);
    expect((err as NoChannelError).model).toBe("claude-haiku-4-5");
  });

  it("should return NoChannelError when body contains Chinese no-channel marker on 200-range status", () => {
    // The marker check fires before the status check in classifyError, so even
    // a non-503 status triggers NoChannelError when the body text matches.
    const err = classifyError(200, noChannelFixture, "glm-4.5");

    expect(err).toBeInstanceOf(NoChannelError);
    expect((err as NoChannelError).model).toBe("glm-4.5");
  });

  it("should mention the model name in the error message", () => {
    const err = classifyError(503, {}, "deepseek-v3.2") as NoChannelError;

    expect(err.message).toContain("deepseek-v3.2");
  });

  it("should suggest trying a different model in the message", () => {
    const err = classifyError(503, {}, "glm-4.6") as NoChannelError;

    expect(err.message).toMatch(/try a different model/i);
  });
});

// ---------------------------------------------------------------------------
// classifyError — AuthError
// ---------------------------------------------------------------------------

describe("classifyError — AuthError", () => {
  it("should return AuthError on 401 without the unauthorized-client marker", () => {
    const err = classifyError(401, { error: { message: "invalid api key" } }, "m");

    expect(err).toBeInstanceOf(AuthError);
    expect(err.status).toBe(401);
    expect(err.name).toBe("AuthError");
  });

  it("should return AuthError on 403", () => {
    const err = classifyError(403, { error: { message: "forbidden" } }, "m");

    expect(err).toBeInstanceOf(AuthError);
    expect(err.status).toBe(403);
  });

  it("should return AuthError when body is null on 401", () => {
    const err = classifyError(401, null, "m");

    expect(err).toBeInstanceOf(AuthError);
  });
});

// ---------------------------------------------------------------------------
// classifyError — RateLimitError
// ---------------------------------------------------------------------------

describe("classifyError — RateLimitError", () => {
  it("should return RateLimitError with retryAfter parsed from header", () => {
    const headers = new Headers({ "retry-after": "5" });
    const err = classifyError(429, {}, "m", headers) as RateLimitError;

    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.status).toBe(429);
    expect(err.retryAfter).toBe(5);
  });

  it("should return RateLimitError with retryAfter undefined when header absent", () => {
    const err = classifyError(429, {}, "m") as RateLimitError;

    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAfter).toBeUndefined();
  });

  it("should return RateLimitError with retryAfter undefined when header is non-numeric", () => {
    const headers = new Headers({ "retry-after": "Thu, 01 Jan 2099 00:00:00 GMT" });
    const err = classifyError(429, {}, "m", headers) as RateLimitError;

    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAfter).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// classifyError — generic fallback
// ---------------------------------------------------------------------------

describe("classifyError — generic AgentRouterError fallback", () => {
  it("should return base AgentRouterError for unrecognised status codes", () => {
    const err = classifyError(500, { error: "internal server error" }, "m");

    expect(err).toBeInstanceOf(AgentRouterError);
    expect(err.constructor.name).toBe("AgentRouterError");
    expect(err.status).toBe(500);
  });

  it("should include the status code in the message for fallback errors", () => {
    const err = classifyError(502, "bad gateway", "m");

    expect(err.message).toContain("502");
  });

  it("should handle null body gracefully and fall through to base error", () => {
    const err = classifyError(500, null, "m");

    expect(err).toBeInstanceOf(AgentRouterError);
    expect(err.message).toContain("no body");
  });
});

// ---------------------------------------------------------------------------
// Error class hierarchy
// ---------------------------------------------------------------------------

describe("error class hierarchy", () => {
  it("UnauthorizedClientError should be instanceof AgentRouterError and Error", () => {
    const err = new UnauthorizedClientError({});

    expect(err).toBeInstanceOf(AgentRouterError);
    expect(err).toBeInstanceOf(Error);
  });

  it("NoChannelError should expose model property and correct status", () => {
    const err = new NoChannelError("glm-4.5", null);

    expect(err).toBeInstanceOf(AgentRouterError);
    expect(err.model).toBe("glm-4.5");
    expect(err.status).toBe(503);
  });

  it("RateLimitError should store retryAfter when provided", () => {
    const err = new RateLimitError({}, 30);

    expect(err.retryAfter).toBe(30);
    expect(err.status).toBe(429);
  });

  it("RateLimitError should leave retryAfter undefined when not provided", () => {
    const err = new RateLimitError({});

    expect(err.retryAfter).toBeUndefined();
  });
});
