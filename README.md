# @rxmxdhxni/agentrouter

Unofficial Node/Bun/Deno SDK for AgentRouter — handles the quirks so you can skip straight to `ar.chat("hi")`.

> [!WARNING]
> AgentRouter (agentrouter.org) is a third-party reseller offering free credits for Claude, DeepSeek, and GLM via a proxy. This package is a community wrapper — not affiliated with or endorsed by AgentRouter or Anthropic. Your prompts pass through AgentRouter's infrastructure; do not send proprietary code, credentials, or sensitive data. For production, get a key directly from the model provider.

## Install

```bash
npm install @rxmxdhxni/agentrouter
# or
bun add @rxmxdhxni/agentrouter
```

> [!IMPORTANT]
> Requires Node 20+, Bun latest, or Deno latest. Zero runtime dependencies.

## Quick start

```typescript
import { AgentRouter } from "@rxmxdhxni/agentrouter";

const ar = new AgentRouter({ apiKey: "sk-..." });
const reply = await ar.chat("What is 2 + 2?");
console.log(reply); // "4"
```

## API

### `new AgentRouter(options)`

| Option      | Type                    | Default                         | Description                                                                         |
| ----------- | ----------------------- | ------------------------------- | ----------------------------------------------------------------------------------- |
| `apiKey`    | `string`                | —                               | **Required.** Your AgentRouter API key                                              |
| `model`     | `string`                | `"claude-opus-4-7"`             | Model for all requests from this instance                                           |
| `maxTokens` | `number`                | `1024`                          | Max tokens per completion                                                           |
| `baseURL`   | `string`                | `"https://agentrouter.org/v1"`  | Override the API endpoint                                                           |
| `userAgent` | `string`                | `"QwenCode/0.2.0 (linux; x64)"` | Override the User-Agent header                                                      |
| `timeout`   | `number`                | `120000`                        | Request timeout in ms                                                               |
| `fetch`     | `typeof fetch`          | `globalThis.fetch`              | Custom fetch. Receives raw `Authorization` header — do not wrap with untrusted code |
| `debug`     | `(msg: string) => void` | —                               | Debug callback. `Authorization` is redacted before the callback is called           |

> [!IMPORTANT]
> `baseURL` must use `https://`. The SDK throws `TypeError` at construction if given `http://`, `file://`, or any non-HTTPS scheme — prevents accidentally leaking your key over plaintext.

### `chat(prompt, opts?)`

Sends a single user message, returns the reply as a string.

```typescript
const reply = await ar.chat("Summarize this in one sentence: ...");
```

> [!NOTE]
> For reasoning models (`glm-4.5`, `glm-5.1`, `deepseek-r1-0528`), `chat()` returns an empty string if the model only produced reasoning output. Use `complete()` to access `result.reasoning`.

### `complete(request)`

Full control over messages, model, and parameters.

```typescript
const result = await ar.complete({
  messages: [
    { role: "system", content: "You are a concise assistant." },
    { role: "user", content: "Explain TCP handshake." },
  ],
  model: "deepseek-v3.2",
  temperature: 0.7,
  maxTokens: 512,
});

console.log(result.content);    // answer text
console.log(result.reasoning);  // defined for reasoning models
console.log(result.usage);      // { promptTokens, completionTokens, totalTokens }
console.log(result.raw);        // unwrapped upstream response
```

**`CompletionRequest` fields:**

| Field         | Type                 | Description                                   |
| ------------- | -------------------- | --------------------------------------------- |
| `messages`    | `ChatMessage[]`      | Required. Array of `{ role, content, name? }` |
| `model`       | `string`             | Overrides instance default                    |
| `maxTokens`   | `number`             | Overrides instance default                    |
| `temperature` | `number`             | 0–2                                           |
| `topP`        | `number`             | Nucleus sampling                              |
| `stop`        | `string \| string[]` | Stop sequences                                |
| `signal`      | `AbortSignal`        | Cancellation                                  |

**`CompletionResult` fields:**

| Field          | Type                  | Description                                                |
| -------------- | --------------------- | ---------------------------------------------------------- |
| `content`      | `string`              | Always a string; `""` if the model only produced reasoning |
| `reasoning`    | `string \| undefined` | Reasoning output from reasoning models                     |
| `usage`        | `Usage`               | Token counts                                               |
| `model`        | `string`              | Model echoed from upstream                                 |
| `finishReason` | `string`              | `"stop"`, `"length"`, etc.                                 |
| `raw`          | `unknown`             | Unwrapped upstream JSON response                           |

### `stream(input, opts?)`

Returns an async iterator of `StreamChunk` objects.

```typescript
for await (const chunk of ar.stream("Write a haiku about DNS.")) {
  if (chunk.type === "content") process.stdout.write(chunk.delta);
  if (chunk.done) break;
}
```

`input` accepts a plain string or a full `CompletionRequest`.

**`StreamChunk` fields:**

| Field   | Type                       | Description                       |
| ------- | -------------------------- | --------------------------------- |
| `type`  | `"content" \| "reasoning"` | Which field this delta belongs to |
| `delta` | `string`                   | Incremental text                  |
| `done`  | `boolean`                  | `true` on the final chunk         |

### `AgentRouter.models`

Static read-only array of known-working models at the time of publish.

```typescript
console.log(AgentRouter.models);
// ["claude-opus-4-6", "claude-opus-4-7", "deepseek-r1-0528", ...]
```

## Models

Working models as of v1 (verified against live API):

- `claude-opus-4-6`
- `claude-opus-4-7` — default
- `deepseek-r1-0528` — reasoning model
- `deepseek-v3.1`
- `deepseek-v3.2`
- `glm-4.5` — reasoning model
- `glm-4.6`
- `glm-5.1` — reasoning model

> [!NOTE]
> Channel availability fluctuates upstream. A model that worked yesterday may return `NoChannelError` today. Check [agentrouter.org](https://agentrouter.org) for the live list of available models, or catch `NoChannelError` and fall back to another model from `AgentRouter.models`.

## Errors

All errors extend `AgentRouterError`, which carries `.status` (HTTP code) and `.body` (raw response).

| Class                     | Status  | Cause                                       | Action                                                                      |
| ------------------------- | ------- | ------------------------------------------- | --------------------------------------------------------------------------- |
| `UnauthorizedClientError` | 401     | Edge rejected the request fingerprint       | SDK bug — do not override `userAgent` or `fetch` without restoring defaults |
| `AuthError`               | 401/403 | Invalid API key                             | Check your key                                                              |
| `NoChannelError`          | 503     | No upstream channel for the requested model | Try a different model; `.model` property names the offender                 |
| `ContentBlockedError`     | 400     | Upstream content policy blocked the prompt  | Rephrase the prompt — switching models does NOT help (filter is edge-level) |
| `RateLimitError`          | 429     | Too many requests                           | Back off; `.retryAfter` (seconds) may be set                                |
| `TimeoutError`            | 0       | Request exceeded `timeout` ms               | Increase `timeout` or retry                                                 |
| `AgentRouterError`        | any     | Unclassified HTTP error                     | Inspect `.status` and `.body`                                               |

> [!NOTE]
> User-initiated aborts (via `AbortSignal`) throw the native `DOMException` / `AbortError` — matches standard `fetch` behavior. `TimeoutError` only fires for the SDK's internal `timeout` option.

```typescript
import {
  AgentRouter,
  NoChannelError,
  RateLimitError,
  UnauthorizedClientError,
} from "@rxmxdhxni/agentrouter";

try {
  const result = await ar.complete({ messages, model: "deepseek-v3.2" });
} catch (err) {
  if (err instanceof NoChannelError) {
    console.error(`No channel for ${err.model} — switching model`);
  } else if (err instanceof RateLimitError) {
    const wait = err.retryAfter ?? 10;
    console.error(`Rate limited. Retry in ${wait}s`);
  } else if (err instanceof UnauthorizedClientError) {
    console.error("SDK misconfigured — do not override userAgent");
  } else {
    throw err;
  }
}
```

## Streaming

Reasoning models emit both `"content"` and `"reasoning"` chunks. Separate them:

```typescript
let answer = "";
let thinking = "";

for await (const chunk of ar.stream({ messages, model: "deepseek-r1-0528" })) {
  if (chunk.type === "content") answer += chunk.delta;
  if (chunk.type === "reasoning") thinking += chunk.delta;
}
```

## FAQ

**Why do I get `unauthorized client detected`?**

AgentRouter blocks requests that don't look like the official OpenAI Node SDK. The SDK ships the exact required headers (`x-stainless-lang: js`, etc.). This error appears when you override `userAgent` or pass a custom `fetch` that strips headers. Revert to defaults.

**Why does `claude-haiku-4-5` or `gpt-5` return a 503?**

Those models have no active upstream channel at AgentRouter right now. The 503 body contains `无可用渠道`. Switch to a model from the [working models list](#models) and catch `NoChannelError` to handle this automatically.

**Why is `content` empty but `reasoning` has text?**

`glm-4.5`, `glm-5.1`, and `deepseek-r1-0528` are reasoning models that put their output in `reasoning_content`, not `content`. Use `complete()` and read `result.reasoning`. `chat()` will return `""` for these models.

**Is this package official?**

No. It is not affiliated with AgentRouter, Anthropic, DeepSeek, or Zhipu AI.

**Can I use the `openai` npm package directly?**

Yes — point `baseURL` at `https://agentrouter.org/v1`. The `openai` package already sends the right Stainless headers. This SDK exists to handle the double-encoded JSON responses from Claude models and to provide typed errors for AgentRouter-specific failures.

## License

MIT
