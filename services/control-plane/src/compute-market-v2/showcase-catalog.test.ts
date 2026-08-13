import { describe, expect, it } from 'vitest';
import { createComputeShowcaseCatalog, computeShowcaseOffers } from './showcase-catalog.js';

describe('compute showcase catalog', () => {
  it('covers every visible GPU series with one read-only hourly offer', () => {
    const catalog = createComputeShowcaseCatalog();

    expect(catalog.getCapabilities()).toMatchObject({
      enabled: true,
      instantPurchase: false,
      reservationPurchase: false,
      hosting: false,
      assets: false,
    });
    expect(computeShowcaseOffers.map((offer) => offer.gpu.model)).toEqual([
      'B300',
      'H100',
      'L40S',
      'RTX 5090',
    ]);

    for (const series of ['RTX', 'H100', 'L40S', 'B300']) {
      expect(catalog.listOffers({ gpuSeries: series }).items).toHaveLength(1);
    }
    for (const offer of catalog.listOffers({}).items) {
      expect(offer).toMatchObject({
        purchaseMode: 'quote',
        providerName: expect.stringContaining('非真实库存'),
        availability: { level: 'quote', label: '方案展示' },
      });
      expect(offer.tags).toContain('方案展示');
      expect(offer.skus[0]).toMatchObject({
        period: 'hour',
        priceCardHoursMilli: null,
        compareAtPriceCardHoursMilli: null,
      });
    }
  });

  it('covers every visible use case and delivery category', () => {
    const catalog = createComputeShowcaseCatalog();

    for (const useCase of ['训练', '推理', '生成式AI', '渲染', '科研']) {
      expect(catalog.listOffers({ useCase }).items.length).toBeGreaterThan(0);
    }
    for (const deliveryMode of ['container', 'virtual_machine', 'bare_metal'] as const) {
      expect(catalog.listOffers({ deliveryMode }).items.length).toBeGreaterThan(0);
    }
  });
});
