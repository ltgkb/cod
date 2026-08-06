export interface ControlPlaneConfig {
  port: number;
  sessionSecret: string;
  databaseUrl: string | null;
  allowedEmailDomains: string[];
  developmentLoginEnabled: boolean;
  developmentLoginEmail: string;
  developmentTopupEnabled: boolean;
  aiBaseUrl: string;
  aiApiKey: string | null;
  wikiBaseUrl: string;
  hongkongBaseUrl: string;
}

export function loadConfig(environment = process.env): ControlPlaneConfig {
  return {
    port: Number(environment.COD_CONTROL_PORT ?? 8787),
    sessionSecret: environment.COD_SESSION_SECRET ?? 'cod-local-development-secret',
    databaseUrl: environment.DATABASE_URL ?? null,
    allowedEmailDomains: (environment.COD_ALLOWED_EMAIL_DOMAINS ?? 'kai.com').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean),
    developmentLoginEnabled: environment.COD_DEVELOPMENT_LOGIN_ENABLED === 'true' || environment.NODE_ENV !== 'production',
    developmentLoginEmail: (environment.COD_DEVELOPMENT_LOGIN_EMAIL ?? 'developer@kai.com').toLowerCase(),
    developmentTopupEnabled: environment.COD_DEVELOPMENT_TOPUP_ENABLED === 'true',
    aiBaseUrl: environment.KAI_AI_BASE_URL ?? 'https://ai.kai.com/v1',
    aiApiKey: environment.KAI_API_KEY ?? null,
    wikiBaseUrl: environment.KAI_WIKI_BASE_URL ?? 'https://wiki.kai.com',
    hongkongBaseUrl: environment.KAI_HONGKONG_BASE_URL ?? 'https://hongkong.kai.com',
  };
}
