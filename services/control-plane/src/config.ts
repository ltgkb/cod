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

export interface WechatPayConfig {
  mchId: string;
  appId: string;
  merchantSerialNo: string;
  merchantPrivateKeyPath: string;
  apiV3Key: string;
  platformPublicKeyPath: string;
  platformSerialNo: string;
}

export interface AlipayConfig {
  appId: string;
  sellerId: string;
  merchantPrivateKeyPath: string;
  alipayPublicKeyPath: string;
  gatewayUrl: string;
}

export interface ControlPlaneConfig {
  port: number;
  sessionSecret: string;
  databaseUrl: string | null;
  allowedEmailDomains: string[];
  allowedOrigins: string[];
  registrationEnabled: boolean;
  inviteCodeRequired: boolean;
  developmentLoginEnabled: boolean;
  developmentLoginEmail: string;
  pilotAccessCodeHash: string | null;
  developmentTopupEnabled: boolean;
  paymentWebhookSecret: string | null;
  paymentPublicBaseUrl: string | null;
  wechatPay: WechatPayConfig | null;
  alipay: AlipayConfig | null;
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
  const production = environment.NODE_ENV === 'production';
  const sessionSecret = environment.COD_SESSION_SECRET ?? 'cod-local-development-secret';
  const databaseUrl = environment.DATABASE_URL ?? null;
  const pilotAccessCodeHash = environment.COD_PILOT_ACCESS_CODE_HASH ?? null;
  const registrationEnabled = environment.COD_REGISTRATION_ENABLED === undefined ? !production : environment.COD_REGISTRATION_ENABLED === 'true';
  const inviteCodeRequired = environment.COD_INVITE_CODE_REQUIRED === undefined ? production : environment.COD_INVITE_CODE_REQUIRED === 'true';
  const developmentLoginEnabled = environment.COD_DEVELOPMENT_LOGIN_ENABLED === 'true' || !production;
  const demoMode = environment.COD_DEMO_MODE === 'true' || !production;
  const paymentWebhookSecret = environment.COD_PAYMENT_WEBHOOK_SECRET ?? null;
  const paymentPublicBaseUrl = environment.COD_PAYMENT_PUBLIC_BASE_URL?.replace(/\/$/, '') ?? null;
  const configuredGroup = <T extends Record<string, string | undefined>>(name: string, values: T): { [K in keyof T]: string } | null => {
    const present = Object.values(values).filter(Boolean).length;
    if (present === 0) return null;
    if (present !== Object.keys(values).length) throw new Error(`${name} configuration is incomplete`);
    return values as { [K in keyof T]: string };
  };
  const wechat = configuredGroup('WeChat Pay', {
    mchId: environment.COD_WECHAT_PAY_MCH_ID,
    appId: environment.COD_WECHAT_PAY_APP_ID,
    merchantSerialNo: environment.COD_WECHAT_PAY_SERIAL_NO,
    merchantPrivateKeyPath: environment.COD_WECHAT_PAY_PRIVATE_KEY_PATH,
    apiV3Key: environment.COD_WECHAT_PAY_API_V3_KEY,
    platformPublicKeyPath: environment.COD_WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH,
    platformSerialNo: environment.COD_WECHAT_PAY_PLATFORM_SERIAL_NO,
  });
  const alipayValues = configuredGroup('Alipay', {
    appId: environment.COD_ALIPAY_APP_ID,
    sellerId: environment.COD_ALIPAY_SELLER_ID,
    merchantPrivateKeyPath: environment.COD_ALIPAY_PRIVATE_KEY_PATH,
    alipayPublicKeyPath: environment.COD_ALIPAY_PUBLIC_KEY_PATH,
  });
  const wechatPay: WechatPayConfig | null = wechat;
  const alipay: AlipayConfig | null = alipayValues ? { ...alipayValues, gatewayUrl: environment.COD_ALIPAY_GATEWAY_URL ?? 'https://openapi.alipay.com/gateway.do' } : null;

  if (pilotAccessCodeHash && !/^[a-f0-9]{64}$/i.test(pilotAccessCodeHash)) {
    throw new Error('COD_PILOT_ACCESS_CODE_HASH must be a SHA-256 hex digest');
  }
  if (production) {
    if (Buffer.byteLength(sessionSecret, 'utf8') < 32 || sessionSecret === 'cod-local-development-secret') {
      throw new Error('Production requires COD_SESSION_SECRET with at least 32 bytes');
    }
    if (!databaseUrl) throw new Error('Production requires DATABASE_URL');
    if (developmentLoginEnabled && !pilotAccessCodeHash) throw new Error('Production pilot login requires COD_PILOT_ACCESS_CODE_HASH');
    if (!demoMode && !environment.KAI_API_KEY) throw new Error('Live production mode requires KAI_API_KEY');
    if (paymentWebhookSecret && Buffer.byteLength(paymentWebhookSecret, 'utf8') < 32) {
      throw new Error('COD_PAYMENT_WEBHOOK_SECRET must contain at least 32 bytes');
    }
  }
  if ((wechatPay || alipay) && !paymentPublicBaseUrl) throw new Error('Official payments require COD_PAYMENT_PUBLIC_BASE_URL');
  if (paymentPublicBaseUrl && !/^https:\/\//.test(paymentPublicBaseUrl)) throw new Error('COD_PAYMENT_PUBLIC_BASE_URL must use HTTPS');
  if (wechatPay && Buffer.byteLength(wechatPay.apiV3Key, 'utf8') !== 32) throw new Error('COD_WECHAT_PAY_API_V3_KEY must contain exactly 32 bytes');
  for (const [label, path] of [
    ['WeChat merchant private key', wechatPay?.merchantPrivateKeyPath],
    ['WeChat platform public key', wechatPay?.platformPublicKeyPath],
    ['Alipay merchant private key', alipay?.merchantPrivateKeyPath],
    ['Alipay public key', alipay?.alipayPublicKeyPath],
  ] as const) if (path && !existsSync(path)) throw new Error(`${label} file does not exist: ${path}`);
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
    sessionSecret,
    databaseUrl,
    allowedEmailDomains: (environment.COD_ALLOWED_EMAIL_DOMAINS ?? 'kai.com').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean),
    allowedOrigins: (environment.COD_ALLOWED_ORIGINS ?? 'http://127.0.0.1:5173,http://localhost:5173,null').split(',').map((value) => value.trim()).filter(Boolean),
    registrationEnabled,
    inviteCodeRequired,
    developmentLoginEnabled,
    developmentLoginEmail: (environment.COD_DEVELOPMENT_LOGIN_EMAIL ?? 'developer@kai.com').toLowerCase(),
    pilotAccessCodeHash,
    developmentTopupEnabled: !production && environment.COD_DEVELOPMENT_TOPUP_ENABLED === 'true',
    paymentWebhookSecret,
    paymentPublicBaseUrl,
    wechatPay,
    alipay,
    feishuVerificationToken: environment.COD_FEISHU_VERIFICATION_TOKEN ?? null,
    feishuEncryptKey: environment.COD_FEISHU_ENCRYPT_KEY ?? null,
    feishuAppId: environment.COD_FEISHU_APP_ID ?? null,
    feishuAppSecret: environment.COD_FEISHU_APP_SECRET ?? null,
    feishuBindings,
    demoMode,
    modelSources: loadModelSources(environment),
    wikiBaseUrl: environment.KAI_WIKI_BASE_URL ?? 'https://wiki.kai.com',
    wikiSearchEndpoint: environment.KAI_WIKI_SEARCH_ENDPOINT ?? null,
    wikiApiKey: environment.KAI_WIKI_API_KEY ?? null,
    hongkongBaseUrl: environment.KAI_HONGKONG_BASE_URL ?? 'https://hongkong.kai.com',
    hongkongEmbedEnabled: environment.KAI_HONGKONG_EMBED_ENABLED === 'true',
    hongkongSsoSecret: environment.KAI_HONGKONG_SSO_SECRET ?? null,
  };
}
import { existsSync } from 'node:fs';
