import { describe, expect, it } from 'vitest';
import { createComputeShowcaseCatalog, computeShowcaseOffers } from './showcase-catalog.js';

describe('compute showcase catalog', () => {
  it('covers every visible GPU series with public hourly prices', () => {
    const catalog = createComputeShowcaseCatalog();

    expect(catalog.getCapabilities()).toMatchObject({
      enabled: true,
      instantPurchase: false,
      reservationPurchase: false,
      hosting: false,
      assets: false,
    });
    expect(new Set(computeShowcaseOffers.map((offer) => offer.gpu.model))).toEqual(new Set(['B300', 'H200', 'H100', 'A100', 'L40S', 'RTX 4090', 'RTX 5090']));

    expect(catalog.listOffers({ gpuSeries: 'H100' }).items).toHaveLength(4);
    for (const series of ['H200', 'A100', 'L40S', 'B300']) expect(catalog.listOffers({ gpuSeries: series }).items).toHaveLength(1);
    expect(catalog.listOffers({ gpuSeries: 'RTX' }).items).toHaveLength(2);
    for (const offer of catalog.listOffers({}).items) {
      expect(offer).toMatchObject({
        purchaseMode: 'instant',
        providerName: 'COD 认证算力节点',
        availability: { level: 'ready', label: '价格公开' },
      });
      expect(offer.tags).not.toContain('方案展示');
      expect(offer.skus[0]).toMatchObject({ period: 'hour', compareAtPriceCardHoursMilli: null, priceCardHoursMilli: expect.any(Number) });
      expect(offer.skus[0]?.imageOptions.map((image) => image.framework)).toContain('纯净环境');
      expect(offer.priceReference).toMatchObject({ currency: 'USD', unit: 'gpu_hour', observedAt: '2026-08-15' });
    }

    const h100 = catalog.listOffers({ gpuSeries: 'H100', sort: 'price_asc' }).items;
    expect(h100.map((offer) => ({
      cards: offer.gpu.countPerUnit,
      cores: offer.specs.cpuCores,
      ramGb: offer.specs.ramGb,
      systemDiskGb: offer.specs.systemDiskGb,
      dataDiskGb: offer.specs.dataDiskGb,
      network: offer.specs.networkLabel,
      price: offer.skus[0]?.priceCardHoursMilli,
    }))).toEqual([
      { cards: 1, cores: 28, ramGb: 120, systemDiskGb: 100, dataDiskGb: 750, network: '10G', price: 20_000 },
      { cards: 2, cores: 60, ramGb: 240, systemDiskGb: 100, dataDiskGb: 1_500, network: '10G', price: 40_000 },
      { cards: 4, cores: 124, ramGb: 480, systemDiskGb: 100, dataDiskGb: 3_200, network: '10G', price: 80_000 },
      { cards: 8, cores: 252, ramGb: 1_440, systemDiskGb: 100, dataDiskGb: 6_500, network: '10G', price: 160_000 },
    ]);

    expect(Object.fromEntries(['B300', 'H200', 'A100', 'L40S', 'RTX 4090', 'RTX 5090'].map((series) => {
      const offer = catalog.listOffers({ gpuSeries: series }).items[0];
      return [series, offer.skus[0]?.priceCardHoursMilli];
    }))).toEqual({ B300: 44_000, H200: 26_000, A100: 13_600, L40S: 7_700, 'RTX 4090': 4_800, 'RTX 5090': 7_000 });
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
