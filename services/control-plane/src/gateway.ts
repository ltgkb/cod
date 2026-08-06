import type { ControlPlaneConfig } from './config.js';

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

  async proxyChat(body: unknown): Promise<Response> {
    if (!this.config.aiApiKey) {
      return Response.json({
        id: 'mock-chat',
        model: 'coder-pro',
        choices: [{ message: { role: 'assistant', content: 'COD 模型网关已就绪，当前使用 Mock 响应。' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 18, total_tokens: 30 },
      });
    }
    return fetch(`${this.config.aiBaseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.config.aiApiKey}` },
      body: JSON.stringify(body),
    });
  }
}
