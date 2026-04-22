import { AgentRouterError, TimeoutError, classifyError } from "./errors.js";

declare const Deno:
  | {
      version: { deno: string };
      build: { os: string; arch: string };
    }
  | undefined;

// Pinned to the openai Node SDK version whose header fingerprint AgentRouter accepts.
const STAINLESS_PACKAGE_VERSION = "6.34.0";
const DEFAULT_USER_AGENT = "QwenCode/0.2.0 (linux; x64)";

// Sentinel used as AbortController reason for internal timeouts. Lets us distinguish
// "we aborted because of timeout" from "caller aborted" without relying on err.name,
// which is inconsistent across Node/Bun/Deno fetch implementations.
const TIMEOUT_REASON = Symbol("agentrouter-timeout");

export interface ResolvedOptions {
  apiKey: string;
  baseURL: string;
  userAgent: string;
  timeout: number;
  fetch: typeof fetch;
  debug?: (message: string) => void;
}

export interface RuntimeInfo {
  runtime: string;
  runtimeVersion: string;
  os: string;
  arch: string;
}

export function detectRuntime(): RuntimeInfo {
  // Deno exposes a global `Deno` object; check before `process` since Bun also
  // exposes `process` but we want Bun detected via process.versions.bun.
  if (typeof Deno !== "undefined" && (Deno as { version?: { deno?: string } }).version?.deno) {
    const deno = Deno as {
      version: { deno: string };
      build: { os: string; arch: string };
    };
    return {
      runtime: "deno",
      runtimeVersion: `deno/${deno.version.deno}`,
      os: mapOs(deno.build.os),
      arch: mapArch(deno.build.arch),
    };
  }

  if (typeof process !== "undefined" && process.versions) {
    const versions = process.versions as Record<string, string | undefined>;

    if (versions.bun) {
      return {
        runtime: "bun",
        runtimeVersion: `bun/${versions.bun}`,
        os: mapOs(process.platform),
        arch: mapArch(process.arch),
      };
    }

    if (versions.node) {
      return {
        runtime: "node",
        runtimeVersion: `node/${versions.node}`,
        os: mapOs(process.platform),
        arch: mapArch(process.arch),
      };
    }
  }

  // Browser / unknown environment — minimal safe defaults.
  return {
    runtime: "browser",
    runtimeVersion: "unknown",
    os: "Unknown",
    arch: "unknown",
  };
}

function mapOs(rawOs: string): string {
  switch (rawOs) {
    case "linux":
      return "Linux";
    case "darwin":
    case "mac":
    case "macos":
      return "MacOS";
    case "win32":
    case "windows":
      return "Windows";
    default:
      return "Unknown";
  }
}

function mapArch(rawArch: string): string {
  switch (rawArch) {
    case "x64":
    case "x86_64":
      return "x64";
    case "arm64":
    case "aarch64":
      return "arm64";
    case "ia32":
    case "x86":
      return "x32";
    default:
      return rawArch || "unknown";
  }
}

export function buildStainlessHeaders(opts: ResolvedOptions): Record<string, string> {
  const rt = detectRuntime();
  return {
    accept: "application/json",
    // Authorization value is set here but never forwarded to the debug callback.
    authorization: `Bearer ${opts.apiKey}`,
    "content-type": "application/json",
    "user-agent": opts.userAgent || DEFAULT_USER_AGENT,
    "x-stainless-arch": rt.arch,
    "x-stainless-lang": "js",
    "x-stainless-os": rt.os,
    "x-stainless-package-version": STAINLESS_PACKAGE_VERSION,
    "x-stainless-retry-count": "0",
    "x-stainless-runtime": rt.runtime,
    "x-stainless-runtime-version": rt.runtimeVersion,
  };
}

// Returns a redacted copy of headers safe to hand to the debug callback.
function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const copy = { ...headers };
  if (copy.authorization) {
    copy.authorization = "Bearer [REDACTED]";
  }
  return copy;
}

// Compose two AbortSignals into one that fires when either fires.
// Uses AbortSignal.any() when available (Node 20+, Bun, Deno); falls back to a
// manual listener approach for Node 18.
function composeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (
    typeof AbortSignal !== "undefined" &&
    typeof (AbortSignal as { any?: unknown }).any === "function"
  ) {
    return (AbortSignal as { any: (signals: AbortSignal[]) => AbortSignal }).any([a, b]);
  }

  const controller = new AbortController();

  const abort = (event: Event) => {
    // Propagate the original reason if available.
    const signal = event.target as AbortSignal;
    controller.abort(signal.reason);
  };

  if (a.aborted) {
    controller.abort(a.reason);
    return controller.signal;
  }
  if (b.aborted) {
    controller.abort(b.reason);
    return controller.signal;
  }

  a.addEventListener("abort", abort, { once: true });
  b.addEventListener("abort", abort, { once: true });

  // Clean up listeners once our composed signal fires to avoid leaks.
  controller.signal.addEventListener(
    "abort",
    () => {
      a.removeEventListener("abort", abort);
      b.removeEventListener("abort", abort);
    },
    { once: true }
  );

  return controller.signal;
}

type RequestBody = { model?: string; [k: string]: unknown };

export class Transport {
  private readonly opts: ResolvedOptions;
  private readonly baseHeaders: Record<string, string>;

  constructor(opts: ResolvedOptions) {
    this.opts = opts;
    this.baseHeaders = buildStainlessHeaders(opts);
  }

  async request(
    path: string,
    body: RequestBody,
    signal?: AbortSignal
  ): Promise<{ data: unknown; headers: Headers }> {
    const { signal: composedSignal, cleanup, timeoutSignal } = this.makeTimeoutSignal(signal);

    try {
      const response = await this.dispatch(path, body, composedSignal);
      const responseHeaders = response.headers;

      if (!response.ok) {
        const parsed = await parseErrorBody(response);
        const model = typeof body.model === "string" ? body.model : "";
        throw classifyError(response.status, parsed, model, responseHeaders);
      }

      const text = await response.text();
      let data: unknown;
      try {
        data = JSON.parse(text);
        // AgentRouter double-encodes Claude responses as a JSON string inside the
        // outer JSON object. DeepSeek and GLM are plain objects, so this is a no-op
        // for them. Always attempting the second parse is safe and future-proof.
        if (typeof data === "string") {
          data = JSON.parse(data);
        }
      } catch (parseErr) {
        if (parseErr instanceof AgentRouterError) throw parseErr;
        // Wrap so callers always see AgentRouterError, never a raw SyntaxError.
        // Common cause: upstream proxy returned an HTML challenge page with 200.
        const snippet = text.length > 200 ? `${text.slice(0, 200)}...` : text;
        throw new AgentRouterError(
          `AgentRouter returned a 2xx response with non-JSON body: ${snippet}`,
          response.status,
          text
        );
      }

      return { data, headers: responseHeaders };
    } catch (err) {
      if (timeoutSignal.aborted && timeoutSignal.reason === TIMEOUT_REASON) {
        throw new TimeoutError(this.opts.timeout);
      }
      throw err;
    } finally {
      cleanup();
    }
  }

  async stream(
    path: string,
    body: RequestBody,
    signal?: AbortSignal
  ): Promise<{
    body: ReadableStream<Uint8Array>;
    headers: Headers;
    timeoutSignal: AbortSignal;
    timeoutMs: number;
  }> {
    // Timeout and caller signal are composed; the timer is NOT cleaned up here
    // because the stream may outlive this call. The timer is .unref()'d in
    // makeTimeoutSignal so it doesn't keep the process alive. The caller
    // (parseSSE) inspects timeoutSignal during body reads to throw TimeoutError
    // when a body read is aborted by our internal timeout.
    const { signal: composedSignal, timeoutSignal } = this.makeTimeoutSignal(signal);

    let response: Response;
    try {
      response = await this.dispatch(path, body, composedSignal);
    } catch (err) {
      if (timeoutSignal.aborted && timeoutSignal.reason === TIMEOUT_REASON) {
        throw new TimeoutError(this.opts.timeout);
      }
      throw err;
    }

    if (!response.ok) {
      const parsed = await parseErrorBody(response);
      const model = typeof body.model === "string" ? body.model : "";
      throw classifyError(response.status, parsed, model, response.headers);
    }

    if (!response.body) {
      throw new Error("AgentRouter stream response had no body.");
    }

    return {
      body: response.body,
      headers: response.headers,
      timeoutSignal,
      timeoutMs: this.opts.timeout,
    };
  }

  private async dispatch(path: string, body: RequestBody, signal: AbortSignal): Promise<Response> {
    const base = this.opts.baseURL.endsWith("/")
      ? this.opts.baseURL.slice(0, -1)
      : this.opts.baseURL;
    const url = `${base}${path}`;
    // Shallow-clone so fetch implementations that normalize or mutate headers
    // don't corrupt the shared baseHeaders across requests.
    const headers = { ...this.baseHeaders };

    this.opts.debug?.(
      JSON.stringify({
        event: "request_start",
        url,
        headers: redactHeaders(headers),
      })
    );

    const response = await this.opts.fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });

    this.opts.debug?.(
      JSON.stringify({
        event: "response_status",
        url,
        status: response.status,
      })
    );

    return response;
  }

  // Creates an AbortSignal that fires after opts.timeout ms. If the caller also
  // provided a signal, the two are composed so either can cancel the request.
  // Returns a cleanup function to cancel the timer when the request finishes
  // before the timeout, preventing the timer from keeping the process alive.
  private makeTimeoutSignal(callerSignal?: AbortSignal): {
    signal: AbortSignal;
    cleanup: () => void;
    timeoutSignal: AbortSignal;
  } {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(TIMEOUT_REASON);
    }, this.opts.timeout);

    // Node-only: allow process to exit even if the timer is still pending.
    // stream() intentionally leaves the timer running past its return, so
    // without unref() a short script would hang for up to opts.timeout ms.
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }

    const cleanup = () => clearTimeout(timer);
    const timeoutSignal = controller.signal;

    if (!callerSignal) {
      return { signal: timeoutSignal, cleanup, timeoutSignal };
    }

    return { signal: composeSignals(timeoutSignal, callerSignal), cleanup, timeoutSignal };
  }
}

async function parseErrorBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
