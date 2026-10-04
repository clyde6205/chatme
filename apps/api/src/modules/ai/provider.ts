/**
 * Provider-neutral AI interface. The gateway, routes and clients speak only
 * these types; vendor adapters translate. Adding Anthropic, Gemini, a
 * self-hosted model or a regional provider means one new adapter.
 */
export interface AIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AIChatRequest {
  model: string;
  messages: AIMessage[];
  maxOutputTokens: number;
  /** Opaque, stable per-user id for the provider's abuse monitoring. Never an email. */
  endUserId: string;
}

export type AIChunk =
  | { type: 'text'; text: string }
  | { type: 'done'; usage: { inputTokens: number; outputTokens: number }; finishReason: string | null };

export interface AIProvider {
  readonly name: string;
  chat(req: AIChatRequest, signal: AbortSignal): AsyncIterable<AIChunk>;
}

export class AIProviderError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
  ) {
    super(message);
  }
}
