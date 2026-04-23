// Known-good models. Channel availability fluctuates upstream — if a call
// returns NoChannelError for one of these, the model is temporarily down,
// not removed. Check agentrouter.org for the live list.
export const KNOWN_MODELS = [
  "claude-opus-4-6",
  "claude-opus-4-7",
  "deepseek-r1-0528",
  "deepseek-v3.1",
  "deepseek-v3.2",
  "glm-4.5",
  "glm-4.6",
  "glm-5.1",
] as const;

export type KnownModel = (typeof KNOWN_MODELS)[number];

export const REASONING_MODELS: ReadonlySet<string> = new Set<string>([
  "glm-4.5",
  "glm-5.1",
  "deepseek-r1-0528",
]);

export const DEFAULT_MODEL: KnownModel = "claude-opus-4-7";

export function isReasoningModel(model: string): boolean {
  return REASONING_MODELS.has(model);
}
