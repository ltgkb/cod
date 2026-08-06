import { randomUUID } from 'node:crypto';
import type { ControlPlaneConfig, ModelSourceConfig } from './config.js';
import { HttpError } from './errors.js';

export interface ModelInfo {
  id: string;
  label: string;
  contextWindow: number;
  inputPricePerMillionCents: number;
  outputPricePerMillionCents: number;
}

export interface ModelSourceInfo {
  id: string;
  label: string;
  status: 'live' | 'catalog' | 'demo' | 'unavailable';
  callable: boolean;
  paymentDirection: string;
  models: ModelInfo[];
  note: string;
}

interface PricingRow {
  model_name?: string;
  quota_type?: number;
  model_ratio?: number;
  completion_ratio?: number;
  supported_endpoint_types?: string[];
}

interface PricingStatus {
  quota_per_unit?: number;
  price?: number;
}

const demoModels: ModelInfo[] = [
  { id: 'coder-pro', label: 'KAI Coder Pro', contextWindow: 200_000, inputPricePerMillionCents: 260, outputPricePerMillionCents: 1_040 },
  { id: 'chat-fast', label: 'KAI Chat Fast', contextWindow: 128_000, inputPricePerMillionCents: 80, outputPricePerMillionCents: 320 },
];

function responseData<T>(value: unknown): T {
  if (value && typeof value === 'object' && 'data' in value) return (value as { data: T }).data;
  return value as T;
}

function sourceNote(source: ModelSourceConfig, callable: boolean): string {
  if (callable) return `真实调用与结算均指向 ${new URL(source.baseUrl).host}`;
  return `仅参考 ${new URL(source.catalogUrl).host} 的公开模型目录，配置该源密钥后才可调用`;
}

export class AiGateway {
  private cache: { expiresAt: number; value: ModelSourceInfo[] } | null = null;

  constructor(private readonly config: ControlPlaneConfig, private readonly fetcher: typeof fetch = fetch) {}

  async listSources(force = false): Promise<ModelSourceInfo[]> {
    if (!force && this.cache && this.cache.expiresAt > Date.now()) return this.cache.value;
    if (!this.config.modelSources.some((source) => source.apiKey)) {
      const value = this.config.demoMode ? [{ id: 'demo', label: 'COD DEMO', status: 'demo' as const, callable: true, paymentDirection: '测试钱包 → COD Demo', models: demoModels, note: '演示响应，不调用外部模型源' }] : [];
      this.cache = { expiresAt: Date.now() + 60_000, value };
      return value;
    }
    const value = await Promise.all(this.config.modelSources.map((source) => this.loadSource(source)));
    this.cache = { expiresAt: Date.now() + 300_000, value };
    return value;
  }

  async mode(): Promise<'live' | 'demo' | 'unavailable'> {
    const sources = await this.listSources();
    if (sources.some((source) => source.status === 'live')) return 'live';
    if (sources.some((source) => source.status === 'demo')) return 'demo';
    return 'unavailable';
  }

  async getSource(sourceId: string): Promise<ModelSourceInfo> {
    const source = (await this.listSources()).find((item) => item.id === sourceId);
    if (!source) throw new HttpError('Unknown model source', 400, 'unknown_source');
    return source;
  }

  async getModel(sourceId: string, modelId: string): Promise<{ source: ModelSourceInfo; model: ModelInfo }> {
    const source = await this.getSource(sourceId);
    const model = source.models.find((item) => item.id === modelId);
    if (!model) throw new HttpError('Unknown model for selected source', 400, 'unknown_model');
    if (!source.callable) throw new HttpError('Selected model source is catalog-only until its API key is configured', 503, 'source_unavailable');
    return { source, model };
  }

  costCents(model: ModelInfo, inputTokens: number, outputTokens: number): number {
    if (![inputTokens, outputTokens].every((value) => Number.isInteger(value) && value >= 0)) throw new Error('Invalid token usage');
    const raw = (inputTokens * model.inputPricePerMillionCents + outputTokens * model.outputPricePerMillionCents) / 1_000_000;
    return inputTokens + outputTokens > 0 ? Math.max(1, Math.ceil(raw)) : 0;
  }

  async proxyChat(sourceId: string, body: unknown): Promise<Response> {
    if (sourceId === 'demo') return this.demoResponse(body);
    const source = this.config.modelSources.find((item) => item.id === sourceId);
    if (!source?.apiKey) throw new HttpError('Selected model source is not configured', 503, 'source_unavailable');
    try {
      return await this.fetcher(`${source.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${source.apiKey}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000),
      });
    } catch (error) {
      throw new HttpError(error instanceof Error && error.name === 'TimeoutError' ? 'KAI model request timed out' : 'KAI model provider is unavailable', 502, 'ai_upstream_unavailable');
    }
  }

  private async loadSource(source: ModelSourceConfig): Promise<ModelSourceInfo> {
    const [pricingResult, statusResult, modelsResult] = await Promise.allSettled([
      this.fetchJson(source.catalogUrl),
      this.fetchJson(source.statusUrl),
      source.apiKey ? this.fetchJson(`${source.baseUrl.replace(/\/$/, '')}/models`, { authorization: `Bearer ${source.apiKey}` }) : Promise.resolve(null),
    ]);
    const pricing = pricingResult.status === 'fulfilled' ? responseData<PricingRow[]>(pricingResult.value) : [];
    const status = statusResult.status === 'fulfilled' ? responseData<PricingStatus>(statusResult.value) : {};
    const advertised = modelsResult.status === 'fulfilled' && modelsResult.value ? responseData<Array<{ id?: string }>>(modelsResult.value) : [];
    const advertisedIds = new Set(advertised.map((item) => item.id).filter((id): id is string => Boolean(id)));
    const authenticated = Boolean(source.apiKey && advertisedIds.size);
    const quotaPerUnit = Number(status.quota_per_unit ?? 500_000);
    const yuanPerUnit = Number(status.price ?? 7);
    const models = (Array.isArray(pricing) ? pricing : []).flatMap((row): ModelInfo[] => {
      const id = row.model_name?.trim(); const ratio = Number(row.model_ratio); const completionRatio = Number(row.completion_ratio ?? 1);
      if (!id || row.quota_type !== 0 || !Number.isFinite(ratio) || ratio <= 0 || !Number.isFinite(completionRatio) || completionRatio <= 0) return [];
      if (row.supported_endpoint_types && !row.supported_endpoint_types.includes('openai')) return [];
      if (authenticated && !advertisedIds.has(id)) return [];
      const inputPrice = Math.max(1, Math.ceil((ratio * 1_000_000 / quotaPerUnit) * yuanPerUnit * 100));
      return [{ id, label: id, contextWindow: 0, inputPricePerMillionCents: inputPrice, outputPricePerMillionCents: Math.max(1, Math.ceil(inputPrice * completionRatio)) }];
    }).sort((left, right) => left.label.localeCompare(right.label));
    const callable = authenticated && models.length > 0;
    const statusName = callable ? 'live' : models.length ? 'catalog' : 'unavailable';
    return { id: source.id, label: source.label, status: statusName, callable, paymentDirection: source.paymentDirection, models, note: sourceNote(source, callable) };
  }

  private async fetchJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
    const response = await this.fetcher(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Catalog request failed: ${response.status}`);
    return response.json();
  }

  private demoResponse(body: unknown): Response {
    const input = body && typeof body === 'object' ? body as { model?: string; messages?: Array<{ role?: string; content?: unknown }> } : {};
    const lastUserMessage = [...(input.messages ?? [])].reverse().find((message) => message.role === 'user');
    const prompt = typeof lastUserMessage?.content === 'string' ? lastUserMessage.content.trim().slice(0, 160) : '';
    const content = prompt ? `COD 当前处于演示模式，已收到：“${prompt}”。配置模型源密钥后将由真实模型处理。` : 'COD 当前处于演示模式。配置模型源密钥后将由真实模型处理。';
    return Response.json({
      id: `demo-${randomUUID()}`, model: input.model ?? 'coder-pro', choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: Math.max(1, Math.ceil(prompt.length / 4)), completion_tokens: Math.max(1, Math.ceil(content.length / 4)), total_tokens: Math.max(2, Math.ceil((prompt.length + content.length) / 4)) }, cod_mode: 'demo',
    });
  }
}
