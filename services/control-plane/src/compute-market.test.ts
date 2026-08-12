import { describe, expect, it } from 'vitest';
import { HttpError } from './errors.js';
import { validateComputeQuote, validateComputeRequest } from './compute-market.js';

const hostingRequest = {
  kind: 'hosting',
  company: '算力设备有限公司',
  contactName: '张经理',
  contactPhone: '13800138000',
  city: '上海',
  gpuModel: 'NVIDIA H100 SXM 80GB',
  quantity: 16,
  requirements: '设备产权与序列号可在线下审核时提供',
  hostingPeriodMonths: 24,
  rackUnits: 8,
  powerKilowatts: 12.5,
  networkMbps: 1000,
  availabilityNotes: '设备预计 2026 年 9 月可入场',
  settlementPreference: '希望由实际托管服务商按月结算并开具发票',
  hostingRequirements: '需第三方合规机房、双路供电、远程运维和书面 SLA',
} as const;

function expectInvalid(input: unknown, code: string): void {
  try {
    validateComputeRequest(input);
    throw new Error('Expected compute request to be rejected');
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(400);
    expect((error as HttpError).code).toBe(code);
  }
}

describe('third-party GPU hosting request validation', () => {
  it('normalizes a complete manually matched hosting request', () => {
    expect(validateComputeRequest(hostingRequest)).toEqual({
      ...hostingRequest,
      offerId: null,
      imageId: null,
      durationHours: null,
      termMonths: null,
    });
  });

  it('accepts availability notes when rack, power, and network figures are not known yet', () => {
    const result = validateComputeRequest({
      ...hostingRequest,
      rackUnits: null,
      powerKilowatts: null,
      networkMbps: null,
      availabilityNotes: '整机已在深圳，可在合同确认后两周内迁入第三方机房',
    });
    expect(result).toMatchObject({ kind: 'hosting', rackUnits: null, powerKilowatts: null, networkMbps: null });
  });

  it('rejects incomplete or out-of-range hosting terms', () => {
    expectInvalid({ ...hostingRequest, hostingPeriodMonths: 0 }, 'invalid_compute_hosting_period');
    expectInvalid({ ...hostingRequest, hostingPeriodMonths: '24' }, 'invalid_compute_hosting_period');
    expectInvalid({ ...hostingRequest, rackUnits: 0 }, 'invalid_compute_rack_units');
    expectInvalid({ ...hostingRequest, powerKilowatts: 1000.1 }, 'invalid_compute_power');
    expectInvalid({ ...hostingRequest, networkMbps: 1.5 }, 'invalid_compute_network');
    expectInvalid({ ...hostingRequest, rackUnits: null, powerKilowatts: null, networkMbps: null, availabilityNotes: '' }, 'invalid_compute_hosting_capacity');
    expectInvalid({ ...hostingRequest, settlementPreference: '' }, 'invalid_compute_hosting_terms');
    expectInvalid({ ...hostingRequest, hostingRequirements: '' }, 'invalid_compute_hosting_terms');
  });

  it('keeps existing request kinds valid while rejecting coerced numeric fields', () => {
    const rental = {
      kind: 'rental', offerId: 'cod-h100-pcie-card-hour', imageId: 'pytorch-2-9', company: '测试企业', contactName: 'Kai', contactPhone: 'kai_compute_2026',
      city: '北京', gpuModel: 'NVIDIA H100 PCIe 80GB', quantity: 2, durationHours: 100, requirements: '模型微调',
    };
    expect(validateComputeRequest(rental)).toMatchObject({ kind: 'rental', quantity: 2, durationHours: 100 });
    expectInvalid({ ...rental, quantity: '2' }, 'invalid_compute_quantity');
    expectInvalid({ ...rental, durationHours: '100' }, 'invalid_compute_duration');
  });

  it('defaults the image for older clients and rejects unknown images', () => {
    const rental = {
      kind: 'rental', offerId: 'cod-h100-pcie-card-hour', company: '测试企业', contactName: 'Kai', contactPhone: 'kai_compute_2026',
      city: '北京', gpuModel: 'NVIDIA H100 PCIe 80GB', quantity: 1, durationHours: 10, requirements: '',
    };
    expect(validateComputeRequest(rental)).toMatchObject({ imageId: 'pytorch-2-9' });
    expectInvalid({ ...rental, imageId: 'unknown-image' }, 'invalid_compute_image');
  });

  it('drops fields that do not belong to the selected request kind', () => {
    const rental = validateComputeRequest({
      kind: 'rental', offerId: 'cod-h100-pcie-card-hour', company: '测试企业', contactName: 'Kai', contactPhone: 'kai_compute_2026',
      city: '北京', gpuModel: 'NVIDIA H100 PCIe 80GB', quantity: 2, durationHours: 100, termMonths: 36, requirements: '模型微调',
      hostingPeriodMonths: 120, rackUnits: 256, powerKilowatts: 1000, networkMbps: 1_000_000,
      availabilityNotes: '不应保留', settlementPreference: '不应保留', hostingRequirements: '不应保留',
    });
    expect(rental).toMatchObject({
      kind: 'rental', offerId: 'cod-h100-pcie-card-hour', durationHours: 100, termMonths: null,
      hostingPeriodMonths: null, rackUnits: null, powerKilowatts: null, networkMbps: null,
      availabilityNotes: null, settlementPreference: null, hostingRequirements: null,
    });

    const hosting = validateComputeRequest({ ...hostingRequest, offerId: 'cod-h100-pcie-card-hour', durationHours: 100, termMonths: 36 });
    expect(hosting).toMatchObject({ kind: 'hosting', offerId: null, durationHours: null, termMonths: null, hostingPeriodMonths: 24 });
  });
});

describe('compute quote validation',()=>{
  const now=new Date('2026-08-12T00:00:00.000Z');
  it('keeps exact cents and thousandths of a card-hour',()=>{
    expect(validateComputeQuote({amountCents:10020,cardHoursMilli:100000,validUntil:'2026-08-19T00:00:00.000Z',terms:'七天内确认'},now)).toEqual({amountCents:10020,cardHoursMilli:100000,validUntil:'2026-08-19T00:00:00.000Z',terms:'七天内确认'});
  });
  it('rejects expired, coerced, and over-posted quotes',()=>{
    for(const input of [
      {amountCents:'10020',cardHoursMilli:100000,validUntil:'2026-08-19T00:00:00.000Z',terms:'七天内确认'},
      {amountCents:10020,cardHoursMilli:100000,validUntil:'2026-08-11T00:00:00.000Z',terms:'七天内确认'},
      {amountCents:10020,validUntil:'2026-08-19T00:00:00.000Z',terms:'七天内确认',status:'approved'},
    ])expect(()=>validateComputeQuote(input,now)).toThrow();
  });
});
