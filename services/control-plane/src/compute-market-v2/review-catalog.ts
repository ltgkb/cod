import type { ComputeCapabilities, ComputeOfferV2 } from '@cod/contracts/compute-market-v2';
import { ComputeCatalogService, defaultComputeCapabilities } from './catalog.js';

export const computeReviewCapabilities: ComputeCapabilities = {
  ...defaultComputeCapabilities,
  enabled: true,
  hosting: true,
  devices: true,
  assets: true,
  referrals: true,
  services: { ...defaultComputeCapabilities.services, onlineSupport: true },
};

export const computeReviewOffers: ComputeOfferV2[] = [{
  id: 'review-rtx-5090-32g',
  slug: 'review-rtx-5090-32g',
  title: 'RTX 5090 / 32 GB（审核样例）',
  status: 'published',
  purchaseMode: 'quote',
  providerName: '本地审核环境 · 非真实库存',
  regionLabel: '审核区域',
  gpu: { model: 'RTX 5090', memoryGb: 32, countPerUnit: 1 },
  specs: {
    cpuModel: 'AMD EPYC',
    cpuCores: 16,
    ramGb: 128,
    systemDiskGb: 100,
    dataDiskGb: 500,
    driverVersion: '570.133',
    cudaVersion: '12.8',
    networkLabel: '审核网络配置',
  },
  tags: ['审核数据', '生成式 AI', '高性能计算'],
  media: [{
    id: 'review-gpu-media',
    url: '/compute/gpu-accelerator.webp',
    alt: '无品牌专业 GPU 加速卡审核样例图',
  }],
  skus: [{
    id: 'review-rtx5090-hour-container',
    offerId: 'review-rtx-5090-32g',
    deliveryMode: 'container',
    period: 'hour',
    minimumUnits: 1,
    maximumUnits: 8,
    priceCardHoursMilli: 64_600,
    compareAtPriceCardHoursMilli: 68_000,
    inventoryRevision: 1,
    imageOptions: [{
      id: 'review-pytorch-241',
      label: 'PyTorch 2.4.1 · Python 3.11',
      framework: 'PyTorch',
      frameworkVersion: '2.4.1',
      pythonVersion: '3.11',
      cudaVersion: '12.8',
    }],
  }],
  availability: { level: 'quote', label: '审核样例' },
  updatedAt: '2026-08-13T00:00:00.000Z',
}];

export function createComputeReviewCatalog(): ComputeCatalogService {
  return new ComputeCatalogService(computeReviewCapabilities, computeReviewOffers);
}
