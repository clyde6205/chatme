import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import type { DB } from '../../db/database.js';
import { AppError } from '../../lib/errors.js';
import type { AIChunk, AIMessage, AIProvider } from './provider.js';

/**
 * AI Gateway: the only path from CHATme to model providers.
 *
 * It owns what must not be left to clients or scattered through features:
 * provider credentials, the system prompt, model selection, per-user daily
 * token budgets, one in-flight request per user, timeouts, cancellation when
 * the client goes away, and usage accounting. Prompts and outputs are not stored.
 */
export interface AIGatewayOptions {
  model: string;
  systemPrompt: string;
  dailyTokenBudget: number;
  maxOutputTokens: number;
  timeoutMs: number;
}

export class AIGateway {
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly db: DB,
    private readonly provider: AIProvider,
    private readonly o: AIGatewayOptions,
  ) {}

  get providerName() {
    return this.provider.name;
  }

  private today() {
    return new Date().toISOString().slice(0, 10);
  }

  async usedToday(userId: string): Promise<number> {
    const row = await this.db
      .selectFrom('ai_usage')
      .select(sql<string>`input_tokens + output_tokens`.as('total'))
      .where('user_id', '=', userId)
      .where('day', '=', this.today())
      .executeTakeFirst();
    return Number(row?.total ?? 0);
  }

  private async record(userId: string, inputTokens: number, outputTokens: number) {
    await this.db
      .insertInto('ai_usage')
      .values({ user_id: userId, day: this.today(), requests: 1, input_tokens: inputTokens, output_tokens: outputTokens })
      .onConflict((oc) =>
        oc.columns(['user_id', 'day']).doUpdateSet({
          requests: sql`ai_usage.requests + 1`,
          input_tokens: sql`ai_usage.input_tokens + ${inputTokens}`,
          output_tokens: sql`ai_usage.output_tokens + ${outputTokens}`,
          updated_at: new Date(),
        }),
      )
      .execute();
  }

  /**
   * Stream a reply. Throws AppError before streaming starts (budget, busy);
   * errors after that surface as a thrown error from the iterator.
   */
  async *chat(userId: string, messages: AIMessage[], clientSignal: AbortSignal): AsyncIterable<AIChunk> {
    if (this.inFlight.has(userId)) throw new AppError('rate_limited', 429);
    if ((await this.usedToday(userId)) >= this.o.dailyTokenBudget) throw new AppError('rate_limited', 429);
    this.inFlight.add(userId);
    const signal = AbortSignal.any([clientSignal, AbortSignal.timeout(this.o.timeoutMs)]);
    let outputChars = 0;
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    try {
      const stream = this.provider.chat(
        {
          model: this.o.model,
          messages: [{ role: 'system', content: this.o.systemPrompt }, ...messages],
          maxOutputTokens: this.o.maxOutputTokens,
          endUserId: createHash('sha256').update(`chatme:${userId}`).digest('hex').slice(0, 32),
        },
        signal,
      );
      for await (const chunk of stream) {
        if (chunk.type === 'text') outputChars += chunk.text.length;
        else usage = chunk.usage;
        yield chunk;
      }
    } finally {
      this.inFlight.delete(userId);
      // Cancelled or failed streams still cost tokens; estimate when the provider sent no usage.
      const inputEstimate = Math.ceil(messages.reduce((n, m) => n + m.content.length, this.o.systemPrompt.length) / 4);
      await this.record(userId, usage?.inputTokens ?? inputEstimate, usage?.outputTokens ?? Math.ceil(outputChars / 4)).catch(() => {});
    }
  }
}
