export interface AgentRouterOptions {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  baseURL?: string;
  userAgent?: string;
  timeout?: number;
  fetch?: typeof fetch;
  debug?: (message: string) => void;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  name?: string;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string | string[];
  signal?: AbortSignal;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface CompletionResult {
  content: string;
  reasoning?: string;
  usage: Usage;
  model: string;
  finishReason: string;
  raw: unknown;
}

export type StreamChunkType = "content" | "reasoning";

export interface StreamChunk {
  type: StreamChunkType;
  delta: string;
  done: boolean;
}

export interface RawChoice {
  index?: number;
  message?: {
    role?: string;
    content?: string | null;
    reasoning_content?: string | null;
  };
  delta?: {
    role?: string;
    content?: string | null;
    reasoning_content?: string | null;
  };
  finish_reason?: string | null;
}

export interface RawCompletionResponse {
  id?: string;
  model?: string;
  created?: number;
  choices?: RawChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  [key: string]: unknown;
}
