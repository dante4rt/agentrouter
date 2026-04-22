import { AgentRouterError, TimeoutError } from "./errors.js";
import type { StreamChunk } from "./types.js";

export interface ParseSSEOptions {
  signal?: AbortSignal;
  // Internal timeout signal from Transport.stream(). When this aborts during a
  // body read, parseSSE throws TimeoutError to keep the public error contract
  // consistent across non-streaming and streaming paths.
  timeoutSignal?: AbortSignal;
  timeoutMs?: number;
}

// Cap on incomplete-frame buffer. Protects against slowloris-style streams
// that never emit \n\n (malicious or misbehaving upstream).
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

// Strip carriage returns so we can split on \n\n uniformly across platforms.
function normalizeLineEndings(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

// Extract all `data: ` lines from one SSE frame and return the concatenated
// payload. Returns null if the frame has no data lines (e.g. pure comment frame).
function extractPayload(frame: string): string | null {
  const lines = frame.split("\n");
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("data:")) {
      // `data:` with no space is valid SSE; strip at most one leading space.
      dataLines.push(line.slice(line.startsWith("data: ") ? 6 : 5));
    }
    // Lines starting with `:` are SSE keep-alive comments — skip.
    // Lines with `event:`, `id:`, `retry:` are not used by OpenAI-style streams.
  }

  if (dataLines.length === 0) return null;
  // Multi-line data payloads per RFC 8895 §9.2 — join with newline.
  return dataLines.join("\n");
}

// Parse one JSON payload with double-JSON-unwrap guard.
// Claude responses from AgentRouter can be double-encoded: the outer value is
// a JSON string that must be parsed a second time to get the actual object.
function parsePayload(payload: string): unknown {
  let obj: unknown;
  try {
    obj = JSON.parse(payload);
  } catch {
    return null;
  }
  // Double-encoded guard: if the parsed result is still a string, unwrap once more.
  if (typeof obj === "string") {
    try {
      obj = JSON.parse(obj);
    } catch {
      return null;
    }
  }
  return obj;
}

// Narrow an unknown value to a plain object.
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function extractDelta(obj: Record<string, unknown>): {
  content: string | null;
  reasoning: string | null;
  finishReason: string | null;
} {
  const choices = obj.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return { content: null, reasoning: null, finishReason: null };
  }

  const first = choices[0];
  if (!isObject(first)) return { content: null, reasoning: null, finishReason: null };

  const delta = first.delta;
  const finishReason = typeof first.finish_reason === "string" ? first.finish_reason : null;

  let content: string | null = null;
  let reasoning: string | null = null;

  if (isObject(delta)) {
    const c = delta.content;
    const r = delta.reasoning_content;
    content = typeof c === "string" ? c : null;
    reasoning = typeof r === "string" ? r : null;
  }

  return { content, reasoning, finishReason };
}

export async function* parseSSE(
  stream: ReadableStream<Uint8Array>,
  signalOrOpts?: AbortSignal | ParseSSEOptions
): AsyncIterable<StreamChunk> {
  // Backwards-compatible signature: accept a bare AbortSignal or an options bag.
  const opts: ParseSSEOptions =
    signalOrOpts instanceof AbortSignal ? { signal: signalOrOpts } : (signalOrOpts ?? {});
  const { signal, timeoutSignal, timeoutMs } = opts;

  const reader = stream.getReader();
  // Per-stream decoder: TextDecoder with {stream: true} is stateful across
  // decode() calls, so a shared instance would corrupt concurrent streams.
  const decoder = new TextDecoder();
  let buffer = "";
  // Guard: emit the terminal done chunk at most once even if [DONE] and
  // finish_reason both appear (some providers send both).
  let doneSent = false;
  // Track whether we've seen a parseable SSE frame. EOF without any valid frame
  // (e.g. HTML challenge page returned with 200) must throw, not silently succeed.
  let sawValidFrame = false;

  const checkTimeout = (err?: unknown): never | undefined => {
    if (timeoutSignal?.aborted) {
      throw new TimeoutError(timeoutMs ?? 0);
    }
    if (err !== undefined) throw err;
  };

  try {
    while (true) {
      if (signal?.aborted) return;

      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (err) {
        // Body-read aborted. If our internal timeout fired, surface as TimeoutError.
        // Otherwise rethrow (caller-aborted = native AbortError, intentional).
        checkTimeout(err);
        throw err;
      }

      const { done, value } = chunk;

      if (done) {
        if (!doneSent) {
          if (!sawValidFrame) {
            // Body closed before any valid SSE frame arrived. Treat as upstream
            // error rather than synthesizing a successful empty completion.
            const preview = buffer.slice(0, 200);
            throw new AgentRouterError(
              `Stream closed without a valid SSE frame${
                preview ? ` (body preview: ${JSON.stringify(preview)})` : ""
              }`,
              0,
              buffer || null
            );
          }
          doneSent = true;
          yield { type: "content", delta: "", done: true };
        }
        return;
      }

      buffer += normalizeLineEndings(decoder.decode(value, { stream: true }));

      if (buffer.length > MAX_BUFFER_BYTES) {
        throw new AgentRouterError(
          `SSE buffer exceeded ${MAX_BUFFER_BYTES} bytes without a frame boundary`,
          0,
          null
        );
      }

      // Split on double-newline frame boundaries. The last element may be an
      // incomplete frame; keep it in the buffer for the next iteration.
      const frames = buffer.split("\n\n");
      // frames.length - 1 = number of complete frames; last element is partial.
      buffer = frames.pop() ?? "";

      for (const frame of frames) {
        if (frame.trim() === "") continue;

        const payload = extractPayload(frame);
        if (payload === null) continue;

        // [DONE] sentinel ends the stream.
        if (payload.trim() === "[DONE]") {
          sawValidFrame = true;
          if (!doneSent) {
            doneSent = true;
            yield { type: "content", delta: "", done: true };
          }
          return;
        }

        const obj = parsePayload(payload);
        // Silently skip unparseable frames (keep-alive or unknown edge payloads).
        if (!isObject(obj)) continue;

        sawValidFrame = true;

        const { content, reasoning, finishReason } = extractDelta(obj);

        // Emit content delta — only when non-empty to avoid spurious empty chunks.
        if (typeof content === "string" && content.length > 0) {
          yield { type: "content", delta: content, done: false };
        }

        // Emit reasoning delta (DeepSeek-R1, GLM-4.5, etc. surface this field).
        if (typeof reasoning === "string" && reasoning.length > 0) {
          yield { type: "reasoning", delta: reasoning, done: false };
        }

        // If finish_reason is set and [DONE] hasn't arrived yet, emit terminal.
        // Some providers close with finish_reason before sending the [DONE] line.
        if (finishReason !== null && !doneSent) {
          doneSent = true;
          yield { type: "content", delta: "", done: true };
        }
      }
    }
  } finally {
    // Always release the lock so callers can discard the stream safely.
    try {
      await reader.cancel();
    } catch {
      // cancel() may throw if the stream is already closed; ignore.
    }
    reader.releaseLock();
  }
}
