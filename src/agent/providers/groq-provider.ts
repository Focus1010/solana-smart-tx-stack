import Groq from "groq-sdk";
import { LlmProvider, LlmCompletionResult, ProviderUnavailableError } from "../llm-provider";

export class GroqProvider implements LlmProvider {
  readonly name = "groq";
  readonly model: string;
  private client: Groq;

  constructor(apiKey: string, model: string) {
    if (!apiKey) throw new ProviderUnavailableError("groq", "GROQ_API_KEY is not set");
    this.model = model;
    this.client = new Groq({ apiKey });
  }

  async complete(prompt: string, maxTokens: number): Promise<LlmCompletionResult> {
    const start = Date.now();
    const completion = await this.client.chat.completions.create({
      model: this.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: maxTokens,
    });
    return {
      text: (completion.choices[0]?.message?.content ?? "").trim(),
      latencyMs: Date.now() - start,
    };
  }
}
