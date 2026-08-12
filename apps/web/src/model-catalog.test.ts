import { describe, expect, it } from 'vitest';
import type { PublicModelSourceInfo } from './api';
import { filterModelCatalog, groupModelCatalog, uniqueCallableModels } from './model-catalog';

const source = (id: string, label: string, callable: boolean, input = 824): PublicModelSourceInfo => ({
  id,
  label,
  upstreamSourceId: 'ai-kai',
  status: callable ? 'live' : 'catalog',
  callable,
  paymentDirection: `归因 ${label}`,
  note: '共享上游',
  models: [{ id: 'glm-5.2', label: 'GLM 5.2', contextWindow: 128_000, inputPricePerMillionCents: input, outputPricePerMillionCents: 2_884 }],
});

describe('model catalog grouping', () => {
  it('merges identical model prices across attribution sources', () => {
    const groups = groupModelCatalog([source('ai-kai', 'AI.KAI.COM', true), source('chase-kai', 'CHASE.KAI.COM', true)]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ callable: true, model: { id: 'glm-5.2' } });
    expect(groups[0]?.sources.map((item) => item.id)).toEqual(['ai-kai', 'chase-kai']);
  });

  it('keeps genuinely different prices as separate rows', () => {
    expect(groupModelCatalog([source('one-kai', 'ONE.KAI.COM', true), source('two-kai', 'TWO.KAI.COM', true, 999)])).toHaveLength(2);
  });

  it('can find a grouped model through any of its source labels', () => {
    const groups = groupModelCatalog([source('ai-kai', 'AI.KAI.COM', true), source('chase-kai', 'CHASE.KAI.COM', false)]);
    expect(filterModelCatalog(groups, 'chase')).toHaveLength(1);
    expect(filterModelCatalog(groups, 'missing')).toHaveLength(0);
  });

  it('offers one comparison target for the same upstream model and price', () => {
    const sources = [source('ai-kai', 'AI.KAI.COM', true), source('chase-kai', 'CHASE.KAI.COM', true)];
    expect(uniqueCallableModels(sources)).toEqual([
      expect.objectContaining({ key: 'ai-kai::glm-5.2', sourceId: 'ai-kai', model: expect.objectContaining({ id: 'glm-5.2' }) }),
    ]);
    expect(uniqueCallableModels([source('one-kai', 'ONE.KAI.COM', true), source('two-kai', 'TWO.KAI.COM', true, 999)])).toHaveLength(2);
  });
});
