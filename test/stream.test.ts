import { describe, expect, it } from "vitest";
import { parseSSE } from "../src/stream.js";
import type { StreamChunk } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStream(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
      }
      controller.close();
    },
  });
}

async function collect(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of parseSSE(stream, signal)) {
    chunks.push(chunk);
  }
  return chunks;
}

function sseFrame(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function contentFrame(content: string, finishReason: string | null = null): string {
  return sseFrame({
    id: "test",
    model: "claude-opus-4-7",
    choices: [{ index: 0, delta: { content }, finish_reason: finishReason }],
  });
}

function reasoningFrame(reasoningContent: string): string {
  return sseFrame({
    id: "test",
    model: "deepseek-r1-0528",
    choices: [{ index: 0, delta: { reasoning_content: reasoningContent }, finish_reason: null }],
  });
}

function finishFrame(): string {
  return sseFrame({
    id: "test",
    model: "claude-opus-4-7",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  });
}

const DONE_FRAME = "data: [DONE]\n\n";

// ---------------------------------------------------------------------------
// Basic frame parsing
// ---------------------------------------------------------------------------

describe("parseSSE — basic content frames", () => {
  it("should yield content chunks for each non-empty delta", async () => {
    const stream = makeStream([contentFrame("Hello"), contentFrame(", world"), DONE_FRAME]);

    const chunks = await collect(stream);
    const content = chunks.filter((c) => c.type === "content" && !c.done);

    expect(content).toHaveLength(2);
    expect(content[0]?.delta).toBe("Hello");
    expect(content[1]?.delta).toBe(", world");
  });

  it("should not yield a content chunk for an empty delta string", async () => {
    const stream = makeStream([contentFrame(""), DONE_FRAME]);

    const chunks = await collect(stream);
    const nonDone = chunks.filter((c) => !c.done);

    expect(nonDone).toHaveLength(0);
  });

  it("should set done:false on content delta chunks", async () => {
    const stream = makeStream([contentFrame("text"), DONE_FRAME]);

    const chunks = await collect(stream);
    const delta = chunks.find((c) => c.delta === "text");

    expect(delta?.done).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// [DONE] terminator
// ---------------------------------------------------------------------------

describe("parseSSE — [DONE] terminator", () => {
  it("should emit a done chunk with empty delta when [DONE] arrives", async () => {
    const stream = makeStream([contentFrame("hi"), DONE_FRAME]);

    const chunks = await collect(stream);
    const terminal = chunks.find((c) => c.done);

    expect(terminal).toBeDefined();
    expect(terminal?.delta).toBe("");
  });

  it("should stop emitting after [DONE]", async () => {
    // Any frames after [DONE] are unreachable in practice, but ensure the
    // generator returns cleanly.
    const stream = makeStream([DONE_FRAME, contentFrame("should not appear")]);

    const chunks = await collect(stream);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.done).toBe(true);
  });

  it("should emit done chunk exactly once when both [DONE] and finish_reason appear", async () => {
    const stream = makeStream([finishFrame(), DONE_FRAME]);

    const chunks = await collect(stream);
    const doneChunks = chunks.filter((c) => c.done);

    expect(doneChunks).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Stream closes without [DONE]
// ---------------------------------------------------------------------------

describe("parseSSE — stream closes without [DONE]", () => {
  it("should emit terminal chunk when stream ends with no [DONE] sentinel", async () => {
    const stream = makeStream([contentFrame("last")]);

    const chunks = await collect(stream);
    const terminal = chunks.find((c) => c.done);

    expect(terminal).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// finish_reason without [DONE]
// ---------------------------------------------------------------------------

describe("parseSSE — finish_reason triggers terminal", () => {
  it("should emit terminal chunk when finish_reason is set before [DONE]", async () => {
    const stream = makeStream([contentFrame("text", "stop")]);

    const chunks = await collect(stream);
    const terminal = chunks.find((c) => c.done);

    expect(terminal).toBeDefined();
    expect(terminal?.delta).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Reasoning chunks
// ---------------------------------------------------------------------------

describe("parseSSE — reasoning chunks", () => {
  it("should emit type:reasoning chunks for reasoning_content delta", async () => {
    const stream = makeStream([
      reasoningFrame("Let me think..."),
      reasoningFrame(" Got it."),
      contentFrame("4"),
      DONE_FRAME,
    ]);

    const chunks = await collect(stream);
    const reasoning = chunks.filter((c) => c.type === "reasoning");

    expect(reasoning).toHaveLength(2);
    expect(reasoning[0]?.delta).toBe("Let me think...");
    expect(reasoning[1]?.delta).toBe(" Got it.");
  });

  it("should interleave reasoning and content chunks in emission order", async () => {
    const stream = makeStream([reasoningFrame("thinking"), contentFrame("answer"), DONE_FRAME]);

    const chunks = await collect(stream);
    const nonDone = chunks.filter((c) => !c.done);

    expect(nonDone[0]?.type).toBe("reasoning");
    expect(nonDone[1]?.type).toBe("content");
  });
});

// ---------------------------------------------------------------------------
// Keep-alive comment lines
// ---------------------------------------------------------------------------

describe("parseSSE — keep-alive comments", () => {
  it("should ignore lines starting with colon (keep-alive ping)", async () => {
    const encoder = new TextEncoder();
    // Frame is a comment-only block — no data lines, so payload is null.
    const pingFrame = ": ping\n\n";
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(pingFrame));
        controller.enqueue(encoder.encode(contentFrame("real")));
        controller.enqueue(encoder.encode(DONE_FRAME));
        controller.close();
      },
    });

    const chunks = await collect(stream);
    const content = chunks.filter((c) => c.type === "content" && !c.done);

    expect(content).toHaveLength(1);
    expect(content[0]?.delta).toBe("real");
  });
});

// ---------------------------------------------------------------------------
// Malformed JSON frames
// ---------------------------------------------------------------------------

describe("parseSSE — malformed JSON", () => {
  it("should silently skip frames with invalid JSON payloads", async () => {
    const encoder = new TextEncoder();
    const badFrame = "data: {this is not json}\n\n";
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(badFrame));
        controller.enqueue(encoder.encode(contentFrame("ok")));
        controller.enqueue(encoder.encode(DONE_FRAME));
        controller.close();
      },
    });

    const chunks = await collect(stream);
    const content = chunks.filter((c) => c.type === "content" && !c.done);

    expect(content).toHaveLength(1);
    expect(content[0]?.delta).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// \r\n line endings
// ---------------------------------------------------------------------------

describe("parseSSE — CRLF line endings", () => {
  it("should handle \\r\\n\\r\\n frame boundaries correctly", async () => {
    const encoder = new TextEncoder();
    // Replace \n\n with \r\n\r\n to simulate Windows/curl-style SSE.
    const crlfContent = `data: ${JSON.stringify({
      id: "t",
      model: "m",
      choices: [{ index: 0, delta: { content: "crlf" }, finish_reason: null }],
    })}\r\n\r\ndata: [DONE]\r\n\r\n`;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(crlfContent));
        controller.close();
      },
    });

    const chunks = await collect(stream);
    const content = chunks.filter((c) => c.type === "content" && !c.done);

    expect(content).toHaveLength(1);
    expect(content[0]?.delta).toBe("crlf");
  });
});

// ---------------------------------------------------------------------------
// Double-encoded JSON frames
// ---------------------------------------------------------------------------

describe("parseSSE — double-encoded JSON frames", () => {
  it("should unwrap Claude-style double-encoded frames correctly", async () => {
    const innerPayload = JSON.stringify({
      id: "double",
      model: "claude-opus-4-7",
      choices: [{ index: 0, delta: { content: "decoded" }, finish_reason: null }],
    });
    // Outer encode: the raw SSE line's data value is itself a JSON string.
    const doubleEncodedFrame = `data: ${JSON.stringify(innerPayload)}\n\n`;

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(doubleEncodedFrame));
        controller.enqueue(encoder.encode(DONE_FRAME));
        controller.close();
      },
    });

    const chunks = await collect(stream);
    const content = chunks.filter((c) => c.type === "content" && !c.done);

    expect(content).toHaveLength(1);
    expect(content[0]?.delta).toBe("decoded");
  });
});

// ---------------------------------------------------------------------------
// Frame split across multiple enqueue calls
// ---------------------------------------------------------------------------

describe("parseSSE — split frames", () => {
  it("should correctly reassemble a frame split across multiple chunks", async () => {
    const fullPayload = JSON.stringify({
      id: "split",
      model: "claude-opus-4-7",
      choices: [{ index: 0, delta: { content: "split" }, finish_reason: null }],
    });
    const fullFrame = `data: ${fullPayload}\n\n`;

    // Split in the middle of the data line.
    const half = Math.floor(fullFrame.length / 2);
    const partA = fullFrame.slice(0, half);
    const partB = fullFrame.slice(half);

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(partA));
        controller.enqueue(encoder.encode(partB));
        controller.enqueue(encoder.encode(DONE_FRAME));
        controller.close();
      },
    });

    const chunks = await collect(stream);
    const content = chunks.filter((c) => c.type === "content" && !c.done);

    expect(content).toHaveLength(1);
    expect(content[0]?.delta).toBe("split");
  });
});

// ---------------------------------------------------------------------------
// Abort signal cancellation
// ---------------------------------------------------------------------------

describe("parseSSE — abort signal", () => {
  it("should stop yielding chunks when the signal is aborted before reading starts", async () => {
    const controller = new AbortController();
    controller.abort();

    const stream = makeStream([contentFrame("never"), DONE_FRAME]);

    const chunks = await collect(stream, controller.signal);

    expect(chunks).toHaveLength(0);
  });

  it("should stop mid-stream when signal fires after first chunk", async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();

    // Use a slow stream that we can interleave abortion with.
    const stream = new ReadableStream<Uint8Array>({
      async start(streamController) {
        streamController.enqueue(encoder.encode(contentFrame("first")));
        // Abort after first frame is enqueued, before reading continues.
        controller.abort();
        streamController.enqueue(encoder.encode(contentFrame("second")));
        streamController.enqueue(encoder.encode(DONE_FRAME));
        streamController.close();
      },
    });

    const chunks = await collect(stream, controller.signal);

    // After abort, the generator checks signal.aborted at the top of the loop.
    // At most the first frame may have been processed.
    const contentChunks = chunks.filter((c) => c.type === "content");
    expect(contentChunks.length).toBeLessThanOrEqual(1);
  });
});
