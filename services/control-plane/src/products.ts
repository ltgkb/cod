import type { ProductManifest } from '@cod/contracts';
import { createHmac } from 'node:crypto';
import type { ControlPlaneConfig } from './config.js';
import type { Principal } from './database.js';
import { HttpError } from './errors.js';

export class ProductRegistry {
  constructor(private readonly config: ControlPlaneConfig) {}

  list(): ProductManifest[] {
    const base = this.config.hongkongBaseUrl.replace(/\/$/, '');
    const embedEnabled = this.config.hongkongEmbedEnabled;
    return [{
      id: 'hongkong',
      name: 'Hong Kong',
      launchUrl: base,
      embedUrl: embedEnabled ? `${base}/embed/cod` : null,
      allowedOrigins: [new URL(base).origin],
      launchMode: this.config.hongkongSsoSecret ? 'signed-sso' : 'external',
    }];
  }

  launch(productId: string, principal: Principal): { url: string; expiresAt: string; mode: 'external' | 'signed-sso' } {
    const product = this.list().find((item) => item.id === productId);
    if (!product) throw new HttpError('Product not found', 404, 'product_not_found');
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    if (!this.config.hongkongSsoSecret) return { url: product.launchUrl, expiresAt: expiresAt.toISOString(), mode: 'external' };
    const claims = Buffer.from(JSON.stringify({ sub: principal.userId, tenantId: principal.tenantId, email: principal.email, aud: 'hongkong.kai.com', exp: Math.floor(expiresAt.getTime() / 1000) })).toString('base64url');
    const signature = createHmac('sha256', this.config.hongkongSsoSecret).update(claims).digest('base64url');
    const url = new URL(product.launchUrl);
    url.searchParams.set('cod_assertion', `${claims}.${signature}`);
    return { url: url.toString(), expiresAt: expiresAt.toISOString(), mode: 'signed-sso' };
  }
}
