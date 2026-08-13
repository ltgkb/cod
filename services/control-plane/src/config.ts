import { existsSync } from 'node:fs';
import { isIP } from 'node:net';
import { nonPublicTokenRetailDomains, tokenRetailDomains, tokenRetailSourceId } from './token-retail-directory.js';

const nonPublicTokenRetailSourceIds = new Set(nonPublicTokenRetailDomains.map(tokenRetailSourceId));
const nonPublicTokenRetailLabels = new Set<string>(nonPublicTokenRetailDomains);
const reservedModelSourceIds = new Set(['demo']);

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

export interface RegistrationWebhookConfig {
  url: string;
  bearerToken: string;
}

export interface RegistrationVerificationConfig {
  hmacKey: string | null;
  emailWebhook: RegistrationWebhookConfig | null;
  smsWebhook: RegistrationWebhookConfig | null;
  turnstileSiteKey: string | null;
  turnstileSecretKey: string | null;
  turnstileVerifyUrl: string;
  turnstileExpectedHostnames: string[];
  turnstileExpectedActions: string[];
  outboundAllowedHostnames: string[];
  otpTtlSeconds: number;
  resendSeconds: number;
  maxSendsPerChannel: number;
  maxFailedAttempts: number;
}

export interface ControlPlaneConfig {
  port: number;
  sessionSecret: string;
  databaseUrl: string | null;
  allowedEmailDomains: string[];
  allowedOrigins: string[];
  registrationEnabled: boolean;
  registrationVerificationRequired: boolean;
  registrationVerification: RegistrationVerificationConfig;
  publicRegistrationUrl: string | null;
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
  computeMarketEnabled: boolean;
  computeReviewMode: boolean;
  modelSources: ModelSourceConfig[];
  wikiBaseUrl: string;
  wikiSearchEndpoint: string | null;
  wikiApiKey: string | null;
  hongkongBaseUrl: string;
  hongkongEmbedEnabled: boolean;
  hongkongSsoSecret: string | null;
}

function modelSourceEndpoints(environment: NodeJS.ProcessEnv): Pick<ModelSourceConfig, 'baseUrl' | 'catalogUrl' | 'statusUrl'> {
  const endpoints = {
    baseUrl: environment.KAI_AI_BASE_URL ?? 'https://ai.kai.com/v1',
    catalogUrl: environment.KAI_AI_CATALOG_URL ?? 'https://ai.kai.com/api/pricing',
    statusUrl: environment.KAI_AI_STATUS_URL ?? 'https://ai.kai.com/api/status',
  };
  if (environment.NODE_ENV !== 'production') return endpoints;

  const allowedHosts = new Set((environment.KAI_AI_ALLOWED_HOSTS ?? 'ai.kai.com')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean));
  if (allowedHosts.size === 0) throw new Error('KAI_AI_ALLOWED_HOSTS must contain at least one hostname');
  const configuredEndpoints = [
    ['KAI_AI_BASE_URL', endpoints.baseUrl],
    ['KAI_AI_CATALOG_URL', endpoints.catalogUrl],
    ['KAI_AI_STATUS_URL', endpoints.statusUrl],
  ] as const;
  for (const [name, value] of configuredEndpoints) {
    let parsed: URL;
    try { parsed = new URL(value); }
    catch { throw new Error(`${name} must be a valid URL`); }
    if (parsed.protocol !== 'https:') throw new Error(`${name} must use HTTPS in production`);
    if (parsed.username || parsed.password) throw new Error(`${name} must not contain URL credentials`);
    if (!allowedHosts.has(parsed.hostname.toLowerCase())) throw new Error(`${name} host is not allowed by KAI_AI_ALLOWED_HOSTS`);
  }
  return endpoints;
}

function defaultModelSources(environment: NodeJS.ProcessEnv, endpoints: Pick<ModelSourceConfig, 'baseUrl' | 'catalogUrl' | 'statusUrl'>): ModelSourceConfig[] {
  const { baseUrl: aiBaseUrl, catalogUrl, statusUrl } = endpoints;
  const apiKey = environment.KAI_API_KEY ?? null;
  const commissionRate = (raw: string | undefined): number => {
    const value = Number(raw ?? 0);
    if (!Number.isInteger(value) || value < 0 || value > 10_000) throw new Error('Source commission rate must be between 0 and 10000 basis points');
    return value;
  };
  const retailCommissionRateBps = commissionRate(environment.TOKEN_RETAIL_COMMISSION_RATE_BPS ?? environment.CHASE_COMMISSION_RATE_BPS);
  return [
    {
      id: 'ai-kai', label: 'AI.KAI.COM', upstreamSourceId: 'ai-kai', baseUrl: aiBaseUrl, catalogUrl,
      statusUrl, paymentDirection: '钱包/额度 → ai.kai.com · 归因 AI.KAI.COM', commissionRateBps: 0, apiKey,
    },
    ...tokenRetailDomains.map((domain) => ({
      id: tokenRetailSourceId(domain), label: domain.toUpperCase(), upstreamSourceId: 'ai-kai' as const, baseUrl: aiBaseUrl, catalogUrl,
      statusUrl, paymentDirection: `钱包/额度 → ai.kai.com · 归因 ${domain.toUpperCase()}`, commissionRateBps: retailCommissionRateBps, apiKey,
    })),
  ];
}

function loadModelSources(environment: NodeJS.ProcessEnv): ModelSourceConfig[] {
  const endpoints = modelSourceEndpoints(environment);
  if (!environment.COD_MODEL_SOURCES_JSON) return defaultModelSources(environment, endpoints);
  const { baseUrl: aiBaseUrl, catalogUrl, statusUrl } = endpoints;
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
    if (reservedModelSourceIds.has(id)) throw new Error(`Model source ${index} uses a reserved ID`);
    if (nonPublicTokenRetailSourceIds.has(id) || nonPublicTokenRetailLabels.has(label.toLowerCase())) throw new Error(`Model source ${index} is non-public`);
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
  const registrationVerificationRequired = environment.COD_REGISTRATION_VERIFICATION_REQUIRED !== 'false';
  const allowedEmailDomains = (environment.COD_ALLOWED_EMAIL_DOMAINS ?? 'kai.com').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  const allowedOrigins = (environment.COD_ALLOWED_ORIGINS ?? (production
    ? 'https://cod.kai.com,https://localhost,capacitor://localhost,null'
    : 'http://127.0.0.1:5173,http://localhost:5173,null')).split(',').map((value) => value.trim()).filter(Boolean);
  const publicRegistrationUrl = environment.COD_PUBLIC_REGISTRATION_URL ?? null;
  // Invitation codes are a referral attribution mechanism, not an account gate.
  // Keep the capability field for older clients, but registration must remain open
  // when a code is omitted in every environment.
  const inviteCodeRequired = false;
  const developmentLoginEnabled = environment.COD_DEVELOPMENT_LOGIN_ENABLED === 'true' || !production;
  // Fake model replies must be an explicit opt-in. Development environments
  // without a provider key stay unavailable instead of silently appearing to
  // complete a real model request.
  const demoMode = environment.COD_DEMO_MODE === 'true';
  const computeMarketEnabled = environment.COD_COMPUTE_MARKET_ENABLED === 'true';
  const computeReviewMode = !production && environment.COD_COMPUTE_REVIEW_MODE === 'true';
  const paymentWebhookSecret = environment.COD_PAYMENT_WEBHOOK_SECRET ?? null;
  const paymentPublicBaseUrl = environment.COD_PAYMENT_PUBLIC_BASE_URL?.replace(/\/$/, '') ?? null;
  const configuredGroup = <T extends Record<string, string | undefined>>(name: string, values: T): { [K in keyof T]: string } | null => {
    const present = Object.values(values).filter(Boolean).length;
    if (present === 0) return null;
    if (present !== Object.keys(values).length) throw new Error(`${name} configuration is incomplete`);
    return values as { [K in keyof T]: string };
  };
  const registrationEmailWebhook = configuredGroup('Registration email webhook', {
    url: environment.COD_REGISTRATION_EMAIL_WEBHOOK_URL,
    bearerToken: environment.COD_REGISTRATION_EMAIL_WEBHOOK_TOKEN,
  });
  const registrationSmsWebhook = configuredGroup('Registration SMS webhook', {
    url: environment.COD_REGISTRATION_SMS_WEBHOOK_URL,
    bearerToken: environment.COD_REGISTRATION_SMS_WEBHOOK_TOKEN,
  });
  const turnstile = configuredGroup('Turnstile', {
    siteKey: environment.COD_TURNSTILE_SITE_KEY,
    secretKey: environment.COD_TURNSTILE_SECRET_KEY,
  });
  const registrationHmacKey = environment.COD_REGISTRATION_HMAC_KEY
    ?? (!production ? '0123456789abcdef0123456789abcdef' : null);
  const decodedRegistrationHmacKey = (value: string | null): Buffer | null => {
    if (!value) return null;
    if (value.startsWith('base64url:')) {
      try { return Buffer.from(value.slice('base64url:'.length), 'base64url'); }
      catch { return null; }
    }
    if (!value.startsWith('base64:')) return Buffer.from(value, 'utf8');
    try {
      const encoded = value.slice('base64:'.length);
      if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
      return Buffer.from(encoded, 'base64');
    } catch { return null; }
  };
  const positiveInteger = (name: string, raw: string | undefined, fallback: number, minimum: number, maximum: number): number => {
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
    return value;
  };
  const hostnameList = (name: string, raw: string | undefined, fallback = ''): string[] => {
    const values=(raw??fallback).split(',').map((value)=>value.trim().toLowerCase()).filter(Boolean);
    if(values.some((value)=>value.length>253||value==='localhost'||!/^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/.test(value)))throw new Error(`${name} must contain valid public hostnames`);
    return [...new Set(values)];
  };
  const configuredRegistrationHosts=[registrationEmailWebhook?.url,registrationSmsWebhook?.url].flatMap((value)=>{try{return value?[new URL(value).hostname.toLowerCase().replace(/\.$/,'')]:[];}catch{return[];}});
  const turnstileExpectedHostnames=hostnameList('COD_TURNSTILE_EXPECTED_HOSTNAMES',environment.COD_TURNSTILE_EXPECTED_HOSTNAMES,production?'':'test.localhost');
  const outboundAllowedHostnames=hostnameList('COD_REGISTRATION_OUTBOUND_ALLOWED_HOSTS',environment.COD_REGISTRATION_OUTBOUND_ALLOWED_HOSTS,production?'':configuredRegistrationHosts.join(','));
  const turnstileExpectedActions=(environment.COD_TURNSTILE_EXPECTED_ACTIONS??'cod_registration_email,cod_registration_phone').split(',').map((value)=>value.trim()).filter(Boolean);
  if(turnstileExpectedActions.length!==2||turnstileExpectedActions.some((value)=>!/^[A-Za-z0-9_-]{1,32}$/.test(value)))throw new Error('COD_TURNSTILE_EXPECTED_ACTIONS must contain the email and phone actions');
  const registrationVerification: RegistrationVerificationConfig = {
    hmacKey: registrationHmacKey,
    emailWebhook: registrationEmailWebhook ? { url: registrationEmailWebhook.url, bearerToken: registrationEmailWebhook.bearerToken } : null,
    smsWebhook: registrationSmsWebhook ? { url: registrationSmsWebhook.url, bearerToken: registrationSmsWebhook.bearerToken } : null,
    turnstileSiteKey: turnstile?.siteKey ?? null,
    turnstileSecretKey: turnstile?.secretKey ?? null,
    turnstileVerifyUrl: environment.COD_TURNSTILE_VERIFY_URL ?? 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    turnstileExpectedHostnames,
    turnstileExpectedActions,
    outboundAllowedHostnames,
    otpTtlSeconds: positiveInteger('COD_REGISTRATION_OTP_TTL_SECONDS', environment.COD_REGISTRATION_OTP_TTL_SECONDS, 600, 60, 3600),
    resendSeconds: positiveInteger('COD_REGISTRATION_RESEND_SECONDS', environment.COD_REGISTRATION_RESEND_SECONDS, 60, 15, 900),
    maxSendsPerChannel: positiveInteger('COD_REGISTRATION_MAX_SENDS_PER_CHANNEL', environment.COD_REGISTRATION_MAX_SENDS_PER_CHANNEL, 3, 1, 10),
    maxFailedAttempts: positiveInteger('COD_REGISTRATION_MAX_FAILED_ATTEMPTS', environment.COD_REGISTRATION_MAX_FAILED_ATTEMPTS, 5, 1, 20),
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
    // An empty COD_ALLOWED_EMAIL_DOMAINS must never silently become "allow all".
    if (allowedEmailDomains.length === 0) throw new Error('Production requires at least one COD_ALLOWED_EMAIL_DOMAINS entry');
    if (paymentWebhookSecret && Buffer.byteLength(paymentWebhookSecret, 'utf8') < 32) {
      throw new Error('COD_PAYMENT_WEBHOOK_SECRET must contain at least 32 bytes');
    }
    if (registrationEnabled && registrationVerificationRequired) {
      if (decodedRegistrationHmacKey(registrationHmacKey)?.length !== 32) throw new Error('Production registration requires COD_REGISTRATION_HMAC_KEY with exactly 32 bytes');
      if (!registrationEmailWebhook) throw new Error('Production registration requires a complete Registration email webhook configuration');
      if (!registrationSmsWebhook) throw new Error('Production registration requires a complete Registration SMS webhook configuration');
      if (!turnstile) throw new Error('Production registration requires complete Turnstile configuration');
      if (turnstileExpectedHostnames.length===0) throw new Error('Production registration requires COD_TURNSTILE_EXPECTED_HOSTNAMES');
      if (outboundAllowedHostnames.length===0) throw new Error('Production registration requires COD_REGISTRATION_OUTBOUND_ALLOWED_HOSTS');
      if (!publicRegistrationUrl) throw new Error('Production registration requires COD_PUBLIC_REGISTRATION_URL');
    }
  }
  if (registrationHmacKey && decodedRegistrationHmacKey(registrationHmacKey)?.length !== 32) throw new Error('COD_REGISTRATION_HMAC_KEY must contain exactly 32 bytes');
  for (const [name, webhook] of [['COD_REGISTRATION_EMAIL_WEBHOOK_URL', registrationEmailWebhook], ['COD_REGISTRATION_SMS_WEBHOOK_URL', registrationSmsWebhook]] as const) {
    if (!webhook) continue;
    let parsed: URL;
    try { parsed = new URL(webhook.url); }
    catch { throw new Error(`${name} must be a valid URL`); }
    if (parsed.username || parsed.password) throw new Error(`${name} must not contain URL credentials`);
    if (parsed.hash) throw new Error(`${name} must not contain a URL fragment`);
    if (production && parsed.port && parsed.port !== '443') throw new Error(`${name} must use port 443 in production`);
    if (production && isIP(parsed.hostname.replace(/^\[|\]$/g,''))) throw new Error(`${name} must use an allowlisted hostname`);
    if (production && parsed.protocol !== 'https:') throw new Error(`${name} must use HTTPS in production`);
    if (!production && parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error(`${name} must use HTTP or HTTPS`);
    if(production&&!outboundAllowedHostnames.includes(parsed.hostname.toLowerCase().replace(/\.$/,'')))throw new Error(`${name} host is not allowed by COD_REGISTRATION_OUTBOUND_ALLOWED_HOSTS`);
  }
  {
    let parsed: URL;
    try { parsed = new URL(registrationVerification.turnstileVerifyUrl); }
    catch { throw new Error('COD_TURNSTILE_VERIFY_URL must be a valid URL'); }
    if (parsed.username || parsed.password) throw new Error('COD_TURNSTILE_VERIFY_URL must not contain URL credentials');
    if (production && parsed.protocol !== 'https:') throw new Error('COD_TURNSTILE_VERIFY_URL must use HTTPS in production');
    if(production&&parsed.hostname.toLowerCase().replace(/\.$/,'')!=='challenges.cloudflare.com')throw new Error('Production COD_TURNSTILE_VERIFY_URL must use challenges.cloudflare.com');
  }
  if (publicRegistrationUrl) {
    let parsed: URL;
    try { parsed = new URL(publicRegistrationUrl); }
    catch { throw new Error('COD_PUBLIC_REGISTRATION_URL must be a valid URL'); }
    if (parsed.username || parsed.password) throw new Error('COD_PUBLIC_REGISTRATION_URL must not contain URL credentials');
    if (production && parsed.protocol !== 'https:') throw new Error('COD_PUBLIC_REGISTRATION_URL must use HTTPS in production');
    if (production && !allowedOrigins.includes(parsed.origin)) throw new Error('COD_PUBLIC_REGISTRATION_URL origin must be listed in COD_ALLOWED_ORIGINS');
  }
  if ((wechatPay || alipay) && !paymentPublicBaseUrl) throw new Error('Official payments require COD_PAYMENT_PUBLIC_BASE_URL');
  if (paymentPublicBaseUrl) {
    let publicBase: URL;
    try { publicBase = new URL(paymentPublicBaseUrl); }
    catch { throw new Error('COD_PAYMENT_PUBLIC_BASE_URL must be a valid HTTPS origin'); }
    if (publicBase.protocol !== 'https:' || publicBase.username || publicBase.password || (publicBase.pathname !== '/' && publicBase.pathname !== '') || publicBase.search || publicBase.hash) throw new Error('COD_PAYMENT_PUBLIC_BASE_URL must be a valid HTTPS origin');
  }
  if (alipay) {
    let gateway: URL;
    try { gateway = new URL(alipay.gatewayUrl); }
    catch { throw new Error('COD_ALIPAY_GATEWAY_URL must be a valid HTTPS URL'); }
    if (gateway.protocol !== 'https:' || gateway.username || gateway.password) throw new Error('COD_ALIPAY_GATEWAY_URL must be a valid HTTPS URL');
    if (production && gateway.hostname.toLowerCase() !== 'openapi.alipay.com') throw new Error('Production COD_ALIPAY_GATEWAY_URL must use openapi.alipay.com');
  }
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
  const modelSources = loadModelSources(environment);
  if (production && modelSources.some((source) => source.commissionRateBps !== 0)) {
    throw new Error('Production source commissions require server-bound attribution');
  }
  return {
    port: Number(environment.COD_CONTROL_PORT ?? 8787),
    sessionSecret,
    databaseUrl,
    allowedEmailDomains,
    allowedOrigins,
    registrationEnabled,
    registrationVerificationRequired,
    registrationVerification,
    publicRegistrationUrl,
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
    computeMarketEnabled,
    computeReviewMode,
    modelSources,
    wikiBaseUrl: environment.KAI_WIKI_BASE_URL ?? 'https://wiki.kai.com',
    wikiSearchEndpoint: environment.KAI_WIKI_SEARCH_ENDPOINT ?? null,
    wikiApiKey: environment.KAI_WIKI_API_KEY ?? null,
    hongkongBaseUrl: environment.KAI_HONGKONG_BASE_URL ?? 'https://hongkong.kai.com',
    hongkongEmbedEnabled: environment.KAI_HONGKONG_EMBED_ENABLED === 'true',
    hongkongSsoSecret: environment.KAI_HONGKONG_SSO_SECRET ?? null,
  };
}
