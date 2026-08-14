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
  gpuCount?: number;
  deliveryMode: ComputeDeliveryMode;
  cpuCores?: number;
  ramGb?: number;
  systemDiskGb?: number;
  dataDiskGb?: number;
  networkLabel?: string;
  priceCardHoursMilli?: number | null;
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
    purchaseMode: 'instant',
    providerName: 'COD 认证算力节点',
    regionLabel: '全国可调度区域',
    gpu: { model: input.model, memoryGb: input.memoryGb, countPerUnit: input.gpuCount ?? 1 },
    specs: {
      cpuModel: '参考配置 · AMD EPYC',
      cpuCores: input.cpuCores ?? 16,
      ramGb: input.ramGb ?? 128,
      systemDiskGb: input.systemDiskGb ?? 100,
      dataDiskGb: input.dataDiskGb ?? 500,
      driverVersion: '交付前确认',
      cudaVersion: input.cudaVersion,
      networkLabel: input.networkLabel ?? '交付前确认',
    },
    tags: input.tags,
    media: media(input.id, input.model),
    skus: [{
      id: `${input.id}-hour`,
      offerId: input.id,
      deliveryMode: input.deliveryMode,
      period: 'hour',
      minimumUnits: 1,
      maximumUnits: 8,
      priceCardHoursMilli: input.priceCardHoursMilli ?? null,
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
    availability: { level: 'ready', label: '价格公开' },
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
    priceCardHoursMilli: 44_000,
    tags: ['训练', '推理', '科研'],
    framework: 'PyTorch',
    frameworkVersion: '2.x',
    pythonVersion: '3.x',
    cudaVersion: '交付前确认',
    updatedAt: '2026-08-13T04:00:00.000Z',
  }),
  showcaseOffer({
    id: 'showcase-h100-1x80g',
    title: '1× H100 / 80 GB',
    model: 'H100',
    memoryGb: 80,
    deliveryMode: 'virtual_machine',
    cpuCores: 28,
    ramGb: 120,
    systemDiskGb: 100,
    dataDiskGb: 750,
    networkLabel: '10G',
    priceCardHoursMilli: 20_000,
    tags: ['训练', '推理', '科研'],
    framework: 'PyTorch',
    frameworkVersion: '2.x',
    pythonVersion: '3.x',
    cudaVersion: '交付前确认',
    updatedAt: '2026-08-13T03:00:00.000Z',
  }),
  showcaseOffer({
    id: 'showcase-h100-2x80g',
    title: '2× H100 / 80 GB',
    model: 'H100',
    memoryGb: 80,
    gpuCount: 2,
    deliveryMode: 'virtual_machine',
    cpuCores: 60,
    ramGb: 240,
    systemDiskGb: 100,
    dataDiskGb: 1_500,
    networkLabel: '10G',
    priceCardHoursMilli: 40_000,
    tags: ['训练', '推理', '科研'],
    framework: 'PyTorch',
    frameworkVersion: '2.x',
    pythonVersion: '3.x',
    cudaVersion: '交付前确认',
    updatedAt: '2026-08-13T02:50:00.000Z',
  }),
  showcaseOffer({
    id: 'showcase-h100-4x80g',
    title: '4× H100 / 80 GB',
    model: 'H100',
    memoryGb: 80,
    gpuCount: 4,
    deliveryMode: 'virtual_machine',
    cpuCores: 124,
    ramGb: 480,
    systemDiskGb: 100,
    dataDiskGb: 3_200,
    networkLabel: '10G',
    priceCardHoursMilli: 80_000,
    tags: ['训练', '推理', '科研'],
    framework: 'PyTorch',
    frameworkVersion: '2.x',
    pythonVersion: '3.x',
    cudaVersion: '交付前确认',
    updatedAt: '2026-08-13T02:40:00.000Z',
  }),
  showcaseOffer({
    id: 'showcase-h100-8x80g',
    title: '8× H100 / 80 GB',
    model: 'H100',
    memoryGb: 80,
    gpuCount: 8,
    deliveryMode: 'virtual_machine',
    cpuCores: 252,
    ramGb: 1_440,
    systemDiskGb: 100,
    dataDiskGb: 6_500,
    networkLabel: '10G',
    priceCardHoursMilli: 160_000,
    tags: ['训练', '推理', '科研'],
    framework: 'PyTorch',
    frameworkVersion: '2.x',
    pythonVersion: '3.x',
    cudaVersion: '交付前确认',
    updatedAt: '2026-08-13T02:30:00.000Z',
  }),
  showcaseOffer({
    id: 'showcase-l40s-48g',
    title: 'L40S / 48 GB',
    model: 'L40S',
    memoryGb: 48,
    deliveryMode: 'container',
    priceCardHoursMilli: 7_700,
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
    priceCardHoursMilli: 7_000,
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
