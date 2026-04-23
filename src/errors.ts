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

export class ContentBlockedError extends AgentRouterError {
  constructor(body: unknown) {
    super(
      "AgentRouter blocked the prompt content. Rephrase the request or pick a different model.",
      400,
      body
    );
    this.name = "ContentBlockedError";
  }
}

const UNAUTHORIZED_CLIENT_MARKER = "unauthorized client detected";
const NO_CHANNEL_MARKER = "无可用渠道";
const CONTENT_BLOCKED_MARKER = "content-blocked";

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

  // NoChannelError requires the explicit marker. A bare 503 could be a generic
  // outage, maintenance page, or upstream proxy failure — sending callers down
  // the "switch model" recovery path would be wrong in those cases.
  if (bodyText.includes(NO_CHANNEL_MARKER)) {
    return new NoChannelError(model, body);
  }

  // 400 + content-blocked marker = upstream content-policy refusal. Distinct
  // from auth/channel/rate errors so callers can route to "rephrase prompt".
  if (status === 400 && bodyText.includes(CONTENT_BLOCKED_MARKER)) {
    return new ContentBlockedError(body);
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
