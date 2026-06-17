export interface LlmCompletionResult {
  text: string;
  latencyMs: number;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  complete(prompt: string, maxTokens: number): Promise<LlmCompletionResult>;
}

export class ProviderUnavailableError extends Error {
  constructor(public readonly providerName: string, reason: string) {
    super(`Provider "${providerName}" unavailable: ${reason}`);
    this.name = "ProviderUnavailableError";
  }
}
