export class AgentRouterError extends Error {
  public readonly status: number;
  public readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "AgentRouterError";
    this.status = status;
    this.body = body;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class UnauthorizedClientError extends AgentRouterError {
  constructor(body: unknown) {
    super(
      "AgentRouter edge rejected the request fingerprint (user-agent or x-stainless-* headers). " +
        "This SDK already ships the expected headers; if you overrode userAgent or fetch, revert to defaults.",
      401,
      body
    );
    this.name = "UnauthorizedClientError";
  }
}

export class NoChannelError extends AgentRouterError {
  public readonly model: string;

  constructor(model: string, body: unknown) {
    super(
      `AgentRouter has no upstream channel for "${model}" right now; try a different model.`,
      503,
      body
    );
    this.name = "NoChannelError";
    this.model = model;
  }
}

export class AuthError extends AgentRouterError {
  constructor(body: unknown, status: 401 | 403 = 401) {
    super("AgentRouter rejected your API key. Check the key and try again.", status, body);
    this.name = "AuthError";
  }
}

export class RateLimitError extends AgentRouterError {
  public readonly retryAfter?: number;

  constructor(body: unknown, retryAfter?: number) {
    super("AgentRouter rate limit hit. Back off and retry.", 429, body);
    this.name = "RateLimitError";
    this.retryAfter = retryAfter;
  }
}

export class TimeoutError extends AgentRouterError {
  constructor(timeout: number) {
    super(`Request to AgentRouter timed out after ${timeout}ms.`, 0, null);
    this.name = "TimeoutError";
  }
}

const UNAUTHORIZED_CLIENT_MARKER = "unauthorized client detected";
const NO_CHANNEL_MARKER = "无可用渠道";

export function classifyError(
  status: number,
  body: unknown,
  model: string,
  headers?: Headers
): AgentRouterError {
  const bodyText = extractBodyText(body);

  if ((status === 401 || status === 403) && bodyText.includes(UNAUTHORIZED_CLIENT_MARKER)) {
    return new UnauthorizedClientError(body);
  }

  if (status === 503 || bodyText.includes(NO_CHANNEL_MARKER)) {
    return new NoChannelError(model, body);
  }

  if (status === 401 || status === 403) {
    return new AuthError(body, status);
  }

  if (status === 429) {
    const retryAfterHeader = headers?.get("retry-after");
    const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : undefined;
    return new RateLimitError(body, Number.isFinite(retryAfter) ? retryAfter : undefined);
  }

  return new AgentRouterError(
    `AgentRouter returned ${status}: ${bodyText.slice(0, 200) || "no body"}`,
    status,
    body
  );
}

function extractBodyText(body: unknown): string {
  if (typeof body === "string") return body.toLowerCase();
  if (body && typeof body === "object") {
    try {
      return JSON.stringify(body).toLowerCase();
    } catch {
      return "";
    }
  }
  return "";
}
