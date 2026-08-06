import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { ProductRegistry } from './products.js';

describe('ProductRegistry', () => {
  it('defaults Hong Kong to external launch until embedding is enabled', () => {
    const product = new ProductRegistry(loadConfig({})).list()[0];
    expect(product.launchUrl).toBe('https://hongkong.kai.com');
    expect(product.embedUrl).toBeNull();
    expect(product.launchMode).toBe('external');
  });

  it('issues a short-lived signed SSO assertion without exposing the secret', () => {
    const registry = new ProductRegistry(loadConfig({ KAI_HONGKONG_SSO_SECRET: 'sso-secret' }));
    const launch = registry.launch('hongkong', { userId: 'user-1', tenantId: 'tenant-1', email: 'user@kai.com', role: 'member' });
    const url = new URL(launch.url);
    expect(launch.mode).toBe('signed-sso');
    expect(url.searchParams.get('cod_assertion')).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(launch.url).not.toContain('sso-secret');
  });
});
