import { AgentRouterError } from "./errors";
import { DEFAULT_MODEL, KNOWN_MODELS } from "./models";
import { parseSSE } from "./stream";
import { type ResolvedOptions, Transport } from "./transport";
import type {
  AgentRouterOptions,
  ChatMessage,
  CompletionRequest,
  CompletionResult,
  RawCompletionResponse,
  StreamChunk,
  Usage,
} from "./types";

const BASE_URL = "https://agentrouter.org/v1";
const USER_AGENT = "QwenCode/0.2.0 (linux; x64)";
const DEFAULT_TIMEOUT = 120_000;
const DEFAULT_MAX_TOKENS = 1024;

function resolveOptions(opts: AgentRouterOptions): ResolvedOptions & {
  model: string;
  maxTokens: number;
  debug?: (message: string) => void;
} {
  if (!opts.apiKey || opts.apiKey.trim() === "") {
    throw new TypeError("AgentRouter: apiKey is required and must not be empty.");
  }

  const baseURL = opts.baseURL ?? BASE_URL;
  // Guard against HTTP downgrade, file://, or open-redirect-style baseURLs that
  // would leak the Authorization header. Callers are expected to pass HTTPS.
  let parsedBaseURL: URL;
  try {
    parsedBaseURL = new URL(baseURL);
  } catch {
    throw new TypeError(`AgentRouter: baseURL is not a valid URL: ${baseURL}`);
  }
  if (parsedBaseURL.protocol !== "https:") {
    throw new TypeError(
      `AgentRouter: baseURL must use https (got ${parsedBaseURL.protocol}). The SDK refuses to send your API key over plaintext or non-HTTP schemes.`
    );
  }

  return {
    apiKey: opts.apiKey,
    baseURL,
    userAgent: opts.userAgent ?? USER_AGENT,
    timeout: opts.timeout ?? DEFAULT_TIMEOUT,
    fetch: opts.fetch ?? globalThis.fetch,
    model: opts.model ?? DEFAULT_MODEL,
    maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    debug: opts.debug,
  };
}

function buildWireBody(
  messages: ChatMessage[],
  model: string,
  maxTokens: number,
  extra: Partial<CompletionRequest>,
  streaming: boolean
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: maxTokens,
    stream: streaming,
  };

  if (extra.temperature !== undefined) body.temperature = extra.temperature;
  if (extra.topP !== undefined) body.top_p = extra.topP;
  if (extra.stop !== undefined) body.stop = extra.stop;

  return body;
}

function mapUsage(raw?: RawCompletionResponse["usage"]): Usage {
  return {
    promptTokens: raw?.prompt_tokens ?? 0,
    completionTokens: raw?.completion_tokens ?? 0,
    totalTokens: raw?.total_tokens ?? 0,
  };
}

function mapResponse(raw: RawCompletionResponse, fallbackModel: string): CompletionResult {
  if (!raw.choices || raw.choices.length === 0) {
    throw new AgentRouterError("AgentRouter returned a malformed response", 200, raw);
  }

  const choice = raw.choices[0];
  if (!choice) {
    throw new AgentRouterError("AgentRouter returned a malformed response", 200, raw);
  }
  const message = choice.message;

  const content = message?.content ?? "";
  const reasoning = message?.reasoning_content ?? undefined;

  return {
    content: typeof content === "string" ? content : "",
    reasoning: typeof reasoning === "string" ? reasoning : undefined,
    usage: mapUsage(raw.usage),
    model: raw.model ?? fallbackModel,
    finishReason: choice.finish_reason ?? "unknown",
    raw,
  };
}

export class AgentRouter {
  static readonly models: readonly string[] = KNOWN_MODELS;

  private readonly transport: Transport;
  private readonly defaultModel: string;
  private readonly defaultMaxTokens: number;
  private readonly debug?: (message: string) => void;

  constructor(opts: AgentRouterOptions) {
    const resolved = resolveOptions(opts);
    this.defaultModel = resolved.model;
    this.defaultMaxTokens = resolved.maxTokens;
    this.debug = resolved.debug;
    this.transport = new Transport(resolved);
  }

  async chat(prompt: string, opts?: { signal?: AbortSignal }): Promise<string> {
    const result = await this.complete({
      messages: [{ role: "user", content: prompt }],
      signal: opts?.signal,
    });

    // Reasoning-only models (e.g. glm-4.5) return empty content with output in reasoning_content.
    // Surface a warning so callers aren't silently surprised by an empty string.
    if (result.content === "" && result.reasoning) {
      this.debug?.(
        `Model "${result.model}" returned no content but has reasoning. Use complete() to access the reasoning field directly.`
      );
    }

    return result.content;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const model = req.model ?? this.defaultModel;
    const maxTokens = req.maxTokens ?? this.defaultMaxTokens;

    const body = buildWireBody(req.messages, model, maxTokens, req, false);

    const { data } = await this.transport.request("/chat/completions", body, req.signal);

    return mapResponse(data as RawCompletionResponse, model);
  }

  async *stream(
    input: string | CompletionRequest,
    opts?: { signal?: AbortSignal }
  ): AsyncIterable<StreamChunk> {
    const req: CompletionRequest =
      typeof input === "string"
        ? { messages: [{ role: "user", content: input }], signal: opts?.signal }
        : { ...input, signal: input.signal ?? opts?.signal };

    const model = req.model ?? this.defaultModel;
    const maxTokens = req.maxTokens ?? this.defaultMaxTokens;

    const body = buildWireBody(req.messages, model, maxTokens, req, true);

    const {
      body: stream,
      timeoutSignal,
      timeoutMs,
    } = await this.transport.stream("/chat/completions", body, req.signal);

    yield* parseSSE(stream, { signal: req.signal, timeoutSignal, timeoutMs });
  }
}
