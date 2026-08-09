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
  upstreamSourceId: 'ai-kai' | 'demo';
  status: 'live' | 'catalog' | 'demo' | 'unavailable';
  callable: boolean;
  paymentDirection: string;
  commissionRateBps: number;
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
const preferredModelOrder = ['glm-5.2', 'glm-4.7', 'deepseek-v3.2', 'gpt-5.2'];

function responseData<T>(value: unknown): T {
  if (value && typeof value === 'object' && 'data' in value) return (value as { data: T }).data;
  return value as T;
}

function sourceNote(source: ModelSourceConfig, callable: boolean): string {
  const attribution = source.commissionRateBps > 0 ? `，按 ${(source.commissionRateBps / 100).toFixed(2)}% 记录渠道分成` : '，分成比例待商务配置';
  if (callable) return `界面按 ${source.label} 展示和归因；真实调用与主结算统一走 ${new URL(source.baseUrl).host}${attribution}`;
  return `模型目录来自 ${new URL(source.catalogUrl).host}；配置 ai.kai.com 密钥后即可调用`;
}

function responseHasAssistantAction(response: Response): Promise<boolean> {
  if (!response.ok) return Promise.resolve(true);
  return response.clone().json().then((body: unknown) => {
    if (!body || typeof body !== 'object') return false;
    const choice = (body as { choices?: unknown[] }).choices?.[0];
    if (!choice || typeof choice !== 'object') return false;
    const message = (choice as { message?: { content?: unknown; tool_calls?: unknown } }).message;
    const content = message?.content;
    if (typeof content === 'string') return Boolean(content.trim());
    if (Array.isArray(content) && content.some((part) => part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' && Boolean(String((part as { text?: unknown }).text).trim()))) return true;
    return Array.isArray(message?.tool_calls) && message.tool_calls.some((call) => {
      if (!call || typeof call !== 'object') return false;
      const fn=(call as {function?:unknown}).function;
      return typeof (call as {id?:unknown}).id==='string'&&fn!==null&&typeof fn==='object'&&typeof (fn as {name?:unknown}).name==='string'&&typeof (fn as {arguments?:unknown}).arguments==='string';
    });
  }).catch(() => false);
}

export class AiGateway {
  private cache: { expiresAt: number; value: ModelSourceInfo[] } | null = null;

  constructor(private readonly config: ControlPlaneConfig, private readonly fetcher: typeof fetch = fetch) {}

  async listSources(force = false): Promise<ModelSourceInfo[]> {
    if (!force && this.cache && this.cache.expiresAt > Date.now()) return this.cache.value;
    if (!this.config.modelSources.some((source) => source.apiKey)) {
      const value = this.config.demoMode ? [{ id: 'demo', label: 'COD DEMO', upstreamSourceId: 'demo' as const, status: 'demo' as const, callable: true, paymentDirection: '测试钱包 → COD Demo', commissionRateBps: 0, models: demoModels, note: '演示响应，不调用外部模型源' }] : [];
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

  async getFallbackModel(sourceId: string, excludedModelId: string): Promise<ModelInfo | null> {
    const source = await this.getSource(sourceId);
    return source.models.find((model) => model.id !== excludedModelId && preferredModelOrder.includes(model.id))
      ?? source.models.find((model) => model.id !== excludedModelId)
      ?? null;
  }

  costCents(model: ModelInfo, inputTokens: number, outputTokens: number): number {
    if (![inputTokens, outputTokens].every((value) => Number.isInteger(value) && value >= 0)) throw new Error('Invalid token usage');
    const raw = (inputTokens * model.inputPricePerMillionCents + outputTokens * model.outputPricePerMillionCents) / 1_000_000;
    return inputTokens + outputTokens > 0 ? Math.max(1, Math.ceil(raw)) : 0;
  }

  async proxyChat(sourceId: string, body: unknown, requestId: string = randomUUID()): Promise<Response> {
    if (sourceId === 'demo') return this.demoResponse(body);
    const source = this.config.modelSources.find((item) => item.id === sourceId);
    if (!source?.apiKey) throw new HttpError('Selected model source is not configured', 503, 'source_unavailable');
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await this.fetcher(`${source.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${source.apiKey}`, 'x-request-id': requestId, 'idempotency-key': requestId },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(120_000),
        });
        const retryableStatus = [408, 425, 429, 500, 502, 503, 504].includes(response.status);
        const hasAction = await responseHasAssistantAction(response);
        if ((!retryableStatus && hasAction) || attempt === 1) return response;
        lastError = new Error(retryableStatus ? `Retryable upstream status: ${response.status}` : 'Empty upstream response');
      } catch (error) {
        lastError = error;
        if (attempt === 1) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new HttpError(lastError instanceof Error && lastError.name === 'TimeoutError' ? 'KAI model request timed out' : 'KAI model provider is unavailable', 502, 'ai_upstream_unavailable');
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
    }).sort((left, right) => {
      const leftRank = preferredModelOrder.indexOf(left.id); const rightRank = preferredModelOrder.indexOf(right.id);
      if (leftRank >= 0 || rightRank >= 0) return (leftRank < 0 ? Number.MAX_SAFE_INTEGER : leftRank) - (rightRank < 0 ? Number.MAX_SAFE_INTEGER : rightRank);
      return left.label.localeCompare(right.label);
    });
    const callable = authenticated && models.length > 0;
    const statusName = callable ? 'live' : models.length ? 'catalog' : 'unavailable';
    return { id: source.id, label: source.label, upstreamSourceId: source.upstreamSourceId, status: statusName, callable, paymentDirection: source.paymentDirection, commissionRateBps: source.commissionRateBps, models, note: sourceNote(source, callable) };
  }

  private async fetchJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
    const response = await this.fetcher(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Catalog request failed: ${response.status}`);
    const advertisedLength = Number(response.headers.get('content-length') ?? 0);
    if (Number.isFinite(advertisedLength) && advertisedLength > 2 * 1024 * 1024) throw new Error('Catalog response is too large');
    const text = await response.text();
    if (text.length > 2 * 1024 * 1024) throw new Error('Catalog response is too large');
    return JSON.parse(text) as unknown;
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
