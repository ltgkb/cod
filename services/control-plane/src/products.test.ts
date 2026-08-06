import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { ProductRegistry } from './products.js';

describe('ProductRegistry', () => {
  it('defaults Hong Kong to external launch until embedding is enabled', () => {
    const product = new ProductRegistry(loadConfig({})).list()[0];
    expect(product.launchUrl).toBe('https://hongkong.kai.com');
    expect(product.embedUrl).toBeNull();
  });
});
