export interface ModelSourceConfig {
  id: string;
  label: string;
  upstreamSourceId: 'ai-kai';
  baseUrl: string;
  catalogUrl: string;
  statusUrl: string;
  paymentDirection: string;
  commissionRateBps: number;
  apiKey: string | null;
}

export interface ControlPlaneConfig {
  port: number;
  sessionSecret: string;
  databaseUrl: string | null;
  allowedEmailDomains: string[];
  allowedOrigins: string[];
  developmentLoginEnabled: boolean;
  developmentLoginEmail: string;
  pilotAccessCodeHash: string | null;
  developmentTopupEnabled: boolean;
  paymentWebhookSecret: string | null;
  feishuVerificationToken: string | null;
  feishuEncryptKey: string | null;
  feishuAppId: string | null;
  feishuAppSecret: string | null;
  feishuBindings: Record<string, string>;
  demoMode: boolean;
  modelSources: ModelSourceConfig[];
  wikiBaseUrl: string;
  wikiSearchEndpoint: string | null;
  wikiApiKey: string | null;
  hongkongBaseUrl: string;
  hongkongEmbedEnabled: boolean;
  hongkongSsoSecret: string | null;
}

function defaultModelSources(environment: NodeJS.ProcessEnv): ModelSourceConfig[] {
  const aiBaseUrl = environment.KAI_AI_BASE_URL ?? 'https://ai.kai.com/v1';
  const catalogUrl = environment.KAI_AI_CATALOG_URL ?? 'https://ai.kai.com/api/pricing';
  const statusUrl = environment.KAI_AI_STATUS_URL ?? 'https://ai.kai.com/api/status';
  const apiKey = environment.KAI_API_KEY ?? null;
  const commissionRate = (raw: string | undefined): number => {
    const value = Number(raw ?? 0);
    if (!Number.isInteger(value) || value < 0 || value > 10_000) throw new Error('Source commission rate must be between 0 and 10000 basis points');
    return value;
  };
  return [
    {
      id: 'ai-kai', label: 'AI.KAI.COM', upstreamSourceId: 'ai-kai', baseUrl: aiBaseUrl, catalogUrl,
      statusUrl, paymentDirection: '钱包/额度 → ai.kai.com · 归因 AI.KAI.COM', commissionRateBps: 0, apiKey,
    },
    {
      id: 'chase-kai', label: 'CHASE.KAI.COM', upstreamSourceId: 'ai-kai', baseUrl: aiBaseUrl, catalogUrl,
      statusUrl, paymentDirection: '钱包/额度 → ai.kai.com · 归因 CHASE.KAI.COM', commissionRateBps: commissionRate(environment.CHASE_COMMISSION_RATE_BPS), apiKey,
    },
  ];
}

function loadModelSources(environment: NodeJS.ProcessEnv): ModelSourceConfig[] {
  if (!environment.COD_MODEL_SOURCES_JSON) return defaultModelSources(environment);
  const aiBaseUrl = environment.KAI_AI_BASE_URL ?? 'https://ai.kai.com/v1';
  const catalogUrl = environment.KAI_AI_CATALOG_URL ?? 'https://ai.kai.com/api/pricing';
  const statusUrl = environment.KAI_AI_STATUS_URL ?? 'https://ai.kai.com/api/status';
  let raw: unknown;
  try { raw = JSON.parse(environment.COD_MODEL_SOURCES_JSON); }
  catch { throw new Error('COD_MODEL_SOURCES_JSON must be valid JSON'); }
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('COD_MODEL_SOURCES_JSON must contain at least one source');
  return raw.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`Model source ${index} is invalid`);
    const source = item as Record<string, unknown>;
    const id = String(source.id ?? '').trim(); const label = String(source.label ?? '').trim();
    const commissionRateBps = Number(source.commissionRateBps ?? 0);
    if (!/^[a-z0-9-]{2,40}$/.test(id) || !label || !Number.isInteger(commissionRateBps) || commissionRateBps < 0 || commissionRateBps > 10_000) throw new Error(`Model source ${index} is incomplete`);
    return {
      id, label, upstreamSourceId: 'ai-kai', baseUrl: aiBaseUrl, catalogUrl, statusUrl,
      paymentDirection: `钱包/额度 → ai.kai.com · 归因 ${label}`, commissionRateBps, apiKey: environment.KAI_API_KEY ?? null,
    };
  });
}

export function loadConfig(environment = process.env): ControlPlaneConfig {
  let feishuBindings: Record<string, string> = {};
  if (environment.COD_FEISHU_BINDINGS_JSON) {
    try {
      const parsed = JSON.parse(environment.COD_FEISHU_BINDINGS_JSON) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      feishuBindings = Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value).trim().toLowerCase()]));
    } catch { throw new Error('COD_FEISHU_BINDINGS_JSON must be a JSON object'); }
  }
  return {
    port: Number(environment.COD_CONTROL_PORT ?? 8787),
    sessionSecret: environment.COD_SESSION_SECRET ?? 'cod-local-development-secret',
    databaseUrl: environment.DATABASE_URL ?? null,
    allowedEmailDomains: (environment.COD_ALLOWED_EMAIL_DOMAINS ?? 'kai.com').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean),
    allowedOrigins: (environment.COD_ALLOWED_ORIGINS ?? 'http://127.0.0.1:5173,http://localhost:5173,null').split(',').map((value) => value.trim()).filter(Boolean),
    developmentLoginEnabled: environment.COD_DEVELOPMENT_LOGIN_ENABLED === 'true' || environment.NODE_ENV !== 'production',
    developmentLoginEmail: (environment.COD_DEVELOPMENT_LOGIN_EMAIL ?? 'developer@kai.com').toLowerCase(),
    pilotAccessCodeHash: environment.COD_PILOT_ACCESS_CODE_HASH ?? null,
    developmentTopupEnabled: environment.COD_DEVELOPMENT_TOPUP_ENABLED === 'true',
    paymentWebhookSecret: environment.COD_PAYMENT_WEBHOOK_SECRET ?? null,
    feishuVerificationToken: environment.COD_FEISHU_VERIFICATION_TOKEN ?? null,
    feishuEncryptKey: environment.COD_FEISHU_ENCRYPT_KEY ?? null,
    feishuAppId: environment.COD_FEISHU_APP_ID ?? null,
    feishuAppSecret: environment.COD_FEISHU_APP_SECRET ?? null,
    feishuBindings,
    demoMode: environment.COD_DEMO_MODE === 'true' || environment.NODE_ENV !== 'production',
    modelSources: loadModelSources(environment),
    wikiBaseUrl: environment.KAI_WIKI_BASE_URL ?? 'https://wiki.kai.com',
    wikiSearchEndpoint: environment.KAI_WIKI_SEARCH_ENDPOINT ?? null,
    wikiApiKey: environment.KAI_WIKI_API_KEY ?? null,
    hongkongBaseUrl: environment.KAI_HONGKONG_BASE_URL ?? 'https://hongkong.kai.com',
    hongkongEmbedEnabled: environment.KAI_HONGKONG_EMBED_ENABLED === 'true',
    hongkongSsoSecret: environment.KAI_HONGKONG_SSO_SECRET ?? null,
  };
}
