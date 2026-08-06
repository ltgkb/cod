import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { KnowledgeAdapter } from './knowledge.js';

describe('KnowledgeAdapter', () => {
  it('returns cited mock knowledge when credentials are absent', async () => {
    const hits = await new KnowledgeAdapter(loadConfig({})).search('Agent');
    expect(hits[0]?.url).toContain('wiki.kai.com');
    expect(hits[0]?.score).toBeGreaterThan(0.8);
    expect(await new KnowledgeAdapter(loadConfig({})).search('unrelated phrase')).toEqual([]);
  });
});
