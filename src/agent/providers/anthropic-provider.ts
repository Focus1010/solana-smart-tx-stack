import Anthropic from "@anthropic-ai/sdk";
import { LlmProvider, LlmCompletionResult, ProviderUnavailableError } from "../llm-provider";

export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  readonly model: string;
  private client: Anthropic;

  constructor(apiKey: string, model: string) {
    if (!apiKey) throw new ProviderUnavailableError("anthropic", "ANTHROPIC_API_KEY is not set");
    this.model = model;
    try {
      this.client = new Anthropic({ apiKey });
    } catch (err) {
      throw new ProviderUnavailableError("anthropic", err instanceof Error ? err.message : String(err));
    }
  }

  async complete(prompt: string, maxTokens: number): Promise<LlmCompletionResult> {
    const start = Date.now();
    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: maxTokens,
        temperature: 0.2,
        messages: [{ role: "user", content: prompt }],
      });
      const block = response.content.find((c) => c.type === "text");
      const text = block && block.type === "text" ? block.text.trim() : "";
      return { text, latencyMs: Date.now() - start };
    } catch (err) {
      throw new ProviderUnavailableError("anthropic", err instanceof Error ? err.message : String(err));
    }
  }
}
