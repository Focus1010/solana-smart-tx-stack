import { LlmProvider, ProviderUnavailableError } from "./llm-provider";
import { GroqProvider } from "./providers/groq-provider";
import { AnthropicProvider } from "./providers/anthropic-provider";
import { Logger } from "../utils/logger";
import { config } from "../config";

export async function createLlmProvider(logger: Logger): Promise<LlmProvider> {
  if (config.aiProvider === "anthropic") {
    try {
      const provider = new AnthropicProvider(config.anthropic.apiKey, config.anthropic.model);
      await logger.info("[agent] Using Anthropic provider", { model: provider.model });
      return provider;
    } catch (err) {
      const reason = err instanceof ProviderUnavailableError ? err.message : String(err);
      await logger.warn("[agent] AI_PROVIDER=anthropic requested but unavailable, falling back to Groq", { reason });
    }
  }
  const groq = new GroqProvider(config.groq.apiKey, config.groq.model);
  await logger.info("[agent] Using Groq provider", { model: groq.model });
  return groq;
}
