import { describe, expect, it } from 'vitest';
import { AGENT_SESSION_TTL_MS, createAgentSessionToken, createSessionToken, verifyAgentSessionToken, verifySessionToken } from './auth.js';

const principal = { sub: 'usr_test', tenantId: 'tenant_test', email: 'user@kai.com', role: 'member' as const };
const scope = { taskId: '11111111-1111-4111-8111-111111111111', sourceId: 'ai-kai', model: 'glm-5.2' };
const secret = 's'.repeat(32);

describe('scoped agent sessions', () => {
  it('separates full sessions from 60-minute task-bound agent tokens', () => {
    const now = 1_000_000;
    const session = createSessionToken(principal, secret, now);
    const agent = createAgentSessionToken(principal, scope, secret, now);
    expect(verifySessionToken(session, secret, now)).toMatchObject(principal);
    expect(verifyAgentSessionToken(session, secret, now)).toBeNull();
    expect(verifySessionToken(agent, secret, now)).toBeNull();
    expect(verifyAgentSessionToken(agent, secret, now)).toMatchObject({ ...principal, ...scope, kind: 'agent', exp: now + AGENT_SESSION_TTL_MS });
    expect(verifyAgentSessionToken(agent, secret, now + AGENT_SESSION_TTL_MS)).toBeNull();
  });

  it('rejects tampered scoped tokens', () => {
    const token = createAgentSessionToken(principal, scope, secret);
    expect(verifyAgentSessionToken(`${token}x`, secret)).toBeNull();
    expect(verifyAgentSessionToken(token, `${secret}x`)).toBeNull();
  });
});
