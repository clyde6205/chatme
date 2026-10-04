import { AIProviderError, type AIChatRequest, type AIChunk, type AIProvider } from './provider.js';

/**
 * OpenAI adapter over the Chat Completions streaming API, using fetch and a
 * small SSE parser (no SDK). The base URL is configurable for tests, proxies
 * and OpenAI-compatible endpoints.
 */
export class OpenAIProvider implements AIProvider {
  readonly name = 'openai';
  constructor(private readonly opts: { apiKey: string; baseUrl: string; organization?: string }) {}

  async *chat(req: AIChatRequest, signal: AbortSignal): AsyncIterable<AIChunk> {
    let res: Response;
    try {
      res = await fetch(`${this.opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.opts.apiKey}`,
          'content-type': 'application/json',
          ...(this.opts.organization ? { 'openai-organization': this.opts.organization } : {}),
        },
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          max_completion_tokens: req.maxOutputTokens,
          stream: true,
          stream_options: { include_usage: true },
          user: req.endUserId,
        }),
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw err;
      throw new AIProviderError(`openai request failed: ${(err as Error).name}`, true);
    }
    if (!res.ok || !res.body) {
      const detail = await res.json().then((b) => String((b as { error?: { code?: unknown } }).error?.code ?? '')).catch(() => '');
      throw new AIProviderError(`openai ${res.status}${detail ? ` ${detail}` : ''}`, res.status === 429 || res.status >= 500, res.status);
    }

    let usage = { inputTokens: 0, outputTokens: 0 };
    let finishReason: string | null = null;
    const decoder = new TextDecoder();
    let buf = '';
    const body = res.body as unknown as AsyncIterable<Uint8Array>;
    const parts = (async function* () {
      try {
        yield* body;
      } catch (err) {
        if (signal.aborted) throw err;
        throw new AIProviderError(`openai stream interrupted: ${(err as Error).name}`, true);
      }
    })();
    for await (const part of parts) {
      buf += decoder.decode(part, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          yield { type: 'done', usage, finishReason };
          return;
        }
        let evt: {
          choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
        };
        try {
          evt = JSON.parse(data);
        } catch {
          continue;
        }
        const choice = evt.choices?.[0];
        if (choice?.delta?.content) yield { type: 'text', text: choice.delta.content };
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (evt.usage) usage = { inputTokens: evt.usage.prompt_tokens ?? 0, outputTokens: evt.usage.completion_tokens ?? 0 };
      }
    }
    // Stream ended without [DONE]: the connection dropped mid-answer.
    throw new AIProviderError('openai stream ended early', true);
  }
}
