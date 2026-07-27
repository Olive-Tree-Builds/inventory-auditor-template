import type { ForecastProvider } from "./forecast-provider";
import { AnthropicMessagesForecastProvider, GoogleGeminiForecastProvider } from "./native-forecast-providers";
import { OpenAIResponsesForecastProvider, type OpenAIResponsesForecastConfig } from "./openai-responses-forecast";
import type { AiProviderFamily } from "./ai-provider-config";

export * from "./ai-provider-config";

export type AiForecastProviderConfig = Omit<OpenAIResponsesForecastConfig, "providerName"> & {
  providerFamily: AiProviderFamily;
};

export function createForecastProvider(config: AiForecastProviderConfig): ForecastProvider {
  if (config.providerFamily === "anthropic") return new AnthropicMessagesForecastProvider(config);
  if (config.providerFamily === "google") return new GoogleGeminiForecastProvider(config);
  return new OpenAIResponsesForecastProvider({
    ...config,
    providerName: config.providerFamily,
  });
}
