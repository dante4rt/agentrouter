// Known-good models. Channel availability fluctuates upstream — if a call
// returns NoChannelError for one of these, the model is temporarily down,
// not removed. Check agentrouter.org for the live list.
export const KNOWN_MODELS = [
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "glm-5.2",
  "gpt-5.5",
] as const;

export type KnownModel = (typeof KNOWN_MODELS)[number];

// glm-5.2 populates both content and reasoning_content (unlike the older
// glm-4.5/5.1/deepseek-r1 generation, which returned empty content).
// chat()'s empty-content guard in client.ts is keyed on actual content
// being "", not on this set, so it already handles both shapes correctly.
export const REASONING_MODELS: ReadonlySet<string> = new Set<string>(["glm-5.2"]);

export const DEFAULT_MODEL: KnownModel = "claude-opus-4-8";

export function isReasoningModel(model: string): boolean {
  return REASONING_MODELS.has(model);
}
