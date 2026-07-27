export const AI_PROVIDER_FAMILIES = ["openai", "anthropic", "google", "responses-compatible"] as const;
export type AiProviderFamily = typeof AI_PROVIDER_FAMILIES[number];

export const AI_PROVIDER_DEFAULTS: Record<AiProviderFamily, { label: string; baseUrl: string; modelPlaceholder: string }> = {
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1", modelPlaceholder: "Enter an OpenAI API model with web search" },
  anthropic: { label: "Anthropic (Claude)", baseUrl: "https://api.anthropic.com/v1", modelPlaceholder: "Enter a Claude API model with web search" },
  google: { label: "Google (Gemini)", baseUrl: "https://generativelanguage.googleapis.com/v1beta", modelPlaceholder: "Enter a Gemini model with Google Search" },
  "responses-compatible": { label: "OpenAI Responses-compatible", baseUrl: "", modelPlaceholder: "Enter the provider's web-search model" },
};

export function normalizeAiProviderFamily(value: unknown): AiProviderFamily | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "openai" || normalized === "openai-responses") return "openai";
  if (normalized === "anthropic" || normalized === "claude") return "anthropic";
  if (normalized === "google" || normalized === "gemini") return "google";
  if (normalized === "responses-compatible") return "responses-compatible";
  return null;
}
