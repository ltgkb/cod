import type { ControlPlaneConfig } from './config.js';
import { HttpError } from './errors.js';

export interface ModelInfo {
  id: string;
  label: string;
  contextWindow: number;
  inputPricePerMillionCents: number;
  outputPricePerMillionCents: number;
}

export const defaultModels: ModelInfo[] = [
  { id: 'coder-pro', label: 'KAI Coder Pro', contextWindow: 200_000, inputPricePerMillionCents: 260, outputPricePerMillionCents: 1_040 },
  { id: 'chat-fast', label: 'KAI Chat Fast', contextWindow: 128_000, inputPricePerMillionCents: 80, outputPricePerMillionCents: 320 },
];

export class AiGateway {
  constructor(private readonly config: ControlPlaneConfig) {}

  listModels(): ModelInfo[] {
    return defaultModels;
  }

  mode(): 'live' | 'demo' | 'unavailable' {
    return this.config.aiApiKey ? 'live' : this.config.demoMode ? 'demo' : 'unavailable';
  }

  costCents(modelId: string, inputTokens: number, outputTokens: number): number {
    const model = defaultModels.find((item) => item.id === modelId);
    if (!model) throw new Error('Unknown model');
    if (![inputTokens, outputTokens].every((value) => Number.isInteger(value) && value >= 0)) throw new Error('Invalid token usage');
    const raw = (inputTokens * model.inputPricePerMillionCents + outputTokens * model.outputPricePerMillionCents) / 1_000_000;
    return inputTokens + outputTokens > 0 ? Math.max(1, Math.ceil(raw)) : 0;
  }

  async proxyChat(body: unknown): Promise<Response> {
    if (!this.config.aiApiKey) {
      if (!this.config.demoMode) throw new HttpError('The KAI model provider is not configured', 503, 'ai_unavailable');
      const input = body && typeof body === 'object' ? body as { model?: string; messages?: Array<{ role?: string; content?: unknown }> } : {};
      const lastUserMessage = [...(input.messages ?? [])].reverse().find((message) => message.role === 'user');
      const prompt = typeof lastUserMessage?.content === 'string' ? lastUserMessage.content.trim().slice(0, 160) : '';
      const content = prompt
        ? `COD 当前处于演示模式，已收到：“${prompt}”。配置 KAI_API_KEY 后将由真实模型处理。`
        : 'COD 当前处于演示模式。配置 KAI_API_KEY 后将由真实模型处理。';
      return Response.json({
        id: 'mock-chat',
        model: input.model ?? 'coder-pro',
        choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: Math.max(1, Math.ceil(prompt.length / 4)), completion_tokens: Math.max(1, Math.ceil(content.length / 4)), total_tokens: Math.max(2, Math.ceil((prompt.length + content.length) / 4)) },
        cod_mode: 'demo',
      });
    }
    try {
      return await fetch(`${this.config.aiBaseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.config.aiApiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (error) {
      throw new HttpError(error instanceof Error && error.name === 'TimeoutError' ? 'KAI model request timed out' : 'KAI model provider is unavailable', 502, 'ai_upstream_unavailable');
    }
  }
}
