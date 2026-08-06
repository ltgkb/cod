export interface ControlPlaneConfig {
  port: number;
  sessionSecret: string;
  aiBaseUrl: string;
  aiApiKey: string | null;
  wikiBaseUrl: string;
  hongkongBaseUrl: string;
}

export function loadConfig(environment = process.env): ControlPlaneConfig {
  return {
    port: Number(environment.COD_CONTROL_PORT ?? 8787),
    sessionSecret: environment.COD_SESSION_SECRET ?? 'cod-local-development-secret',
    aiBaseUrl: environment.KAI_AI_BASE_URL ?? 'https://ai.kai.com/v1',
    aiApiKey: environment.KAI_API_KEY ?? null,
    wikiBaseUrl: environment.KAI_WIKI_BASE_URL ?? 'https://wiki.kai.com',
    hongkongBaseUrl: environment.KAI_HONGKONG_BASE_URL ?? 'https://hongkong.kai.com',
  };
}
