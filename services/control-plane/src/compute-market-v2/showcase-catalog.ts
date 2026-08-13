import type { ComputeCapabilities, ComputeDeliveryMode, ComputeOfferV2 } from '@cod/contracts/compute-market-v2';
import { ComputeCatalogService, defaultComputeCapabilities } from './catalog.js';

export const computeShowcaseCapabilities: ComputeCapabilities = {
  ...defaultComputeCapabilities,
  enabled: true,
};

const media = (id: string, model: string): ComputeOfferV2['media'] => [{
  id: `${id}-media`,
  url: '/compute/gpu-accelerator.webp',
  alt: `${model} 无品牌 GPU 加速卡方案展示图`,
}];

function showcaseOffer(input: {
  id: string;
  title: string;
  model: string;
  memoryGb: number;
  deliveryMode: ComputeDeliveryMode;
  tags: string[];
  framework: string;
  frameworkVersion: string;
  pythonVersion: string;
  cudaVersion: string;
  updatedAt: string;
}): ComputeOfferV2 {
  return {
    id: input.id,
    slug: input.id,
    title: input.title,
    status: 'published',
    purchaseMode: 'quote',
    providerName: 'COD 方案展示 · 非真实库存',
    regionLabel: '交付区域待确认',
    gpu: { model: input.model, memoryGb: input.memoryGb, countPerUnit: 1 },
    specs: {
      cpuModel: '参考配置 · AMD EPYC',
      cpuCores: 16,
      ramGb: 128,
      systemDiskGb: 100,
      dataDiskGb: 500,
      driverVersion: '交付前确认',
      cudaVersion: input.cudaVersion,
      networkLabel: '交付前确认',
    },
    tags: ['方案展示', ...input.tags],
    media: media(input.id, input.model),
    skus: [{
      id: `${input.id}-hour`,
      offerId: input.id,
      deliveryMode: input.deliveryMode,
      period: 'hour',
      minimumUnits: 1,
      maximumUnits: 8,
      priceCardHoursMilli: null,
      compareAtPriceCardHoursMilli: null,
      inventoryRevision: 1,
      imageOptions: [{
        id: `${input.id}-image`,
        label: `${input.framework} ${input.frameworkVersion} · Python ${input.pythonVersion}`,
        framework: input.framework,
        frameworkVersion: input.frameworkVersion,
        pythonVersion: input.pythonVersion,
        cudaVersion: input.cudaVersion,
      }],
    }],
    availability: { level: 'quote', label: '方案展示' },
    updatedAt: input.updatedAt,
  };
}

export const computeShowcaseOffers: ComputeOfferV2[] = [
  showcaseOffer({
    id: 'showcase-b300-288g',
    title: 'B300 / 288 GB',
    model: 'B300',
    memoryGb: 288,
    deliveryMode: 'bare_metal',
    tags: ['训练', '推理', '科研'],
    framework: 'PyTorch',
    frameworkVersion: '2.x',
    pythonVersion: '3.x',
    cudaVersion: '交付前确认',
    updatedAt: '2026-08-13T04:00:00.000Z',
  }),
  showcaseOffer({
    id: 'showcase-h100-80g',
    title: 'H100 / 80 GB',
    model: 'H100',
    memoryGb: 80,
    deliveryMode: 'virtual_machine',
    tags: ['训练', '推理', '科研'],
    framework: 'PyTorch',
    frameworkVersion: '2.x',
    pythonVersion: '3.x',
    cudaVersion: '交付前确认',
    updatedAt: '2026-08-13T03:00:00.000Z',
  }),
  showcaseOffer({
    id: 'showcase-l40s-48g',
    title: 'L40S / 48 GB',
    model: 'L40S',
    memoryGb: 48,
    deliveryMode: 'container',
    tags: ['推理', '生成式AI', '渲染'],
    framework: 'ComfyUI',
    frameworkVersion: '交付版',
    pythonVersion: '3.x',
    cudaVersion: '交付前确认',
    updatedAt: '2026-08-13T02:00:00.000Z',
  }),
  showcaseOffer({
    id: 'showcase-rtx-5090-32g',
    title: 'RTX 5090 / 32 GB',
    model: 'RTX 5090',
    memoryGb: 32,
    deliveryMode: 'container',
    tags: ['生成式AI', '渲染', '推理'],
    framework: 'PyTorch',
    frameworkVersion: '2.x',
    pythonVersion: '3.x',
    cudaVersion: '交付前确认',
    updatedAt: '2026-08-13T01:00:00.000Z',
  }),
];

export function createComputeShowcaseCatalog(): ComputeCatalogService {
  return new ComputeCatalogService(computeShowcaseCapabilities, computeShowcaseOffers);
}
