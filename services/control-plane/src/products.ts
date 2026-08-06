import type { ProductManifest } from '@cod/contracts';
import type { ControlPlaneConfig } from './config.js';

export class ProductRegistry {
  constructor(private readonly config: ControlPlaneConfig) {}

  list(): ProductManifest[] {
    const base = this.config.hongkongBaseUrl.replace(/\/$/, '');
    const embedEnabled = process.env.KAI_HONGKONG_EMBED_ENABLED === 'true';
    return [{
      id: 'hongkong',
      name: 'Hong Kong',
      launchUrl: base,
      embedUrl: embedEnabled ? `${base}/embed/cod` : null,
      allowedOrigins: [new URL(base).origin],
    }];
  }
}
