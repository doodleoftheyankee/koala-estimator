import { describe, expect, it } from 'vitest';
import { canonicalModel, pickBackend } from './backend';
import { readCostUsd } from './photoRead';

describe('pickBackend', () => {
  it('prefers a direct Anthropic key', () => {
    expect(pickBackend({ ANTHROPIC_API_KEY: 'k', VERCEL: '1' })).toEqual({ kind: 'anthropic', model: 'claude-opus-5-5' });
  });
  it('uses the AI Gateway with its key, or the Vercel deployment token', () => {
    expect(pickBackend({ AI_GATEWAY_API_KEY: 'g' })).toMatchObject({ kind: 'gateway', model: 'anthropic/claude-opus-5.5', auth: 'key', baseURL: 'https://ai-gateway.vercel.sh' });
    expect(pickBackend({ VERCEL: '1' })).toMatchObject({ kind: 'gateway', auth: 'oidc' });
    expect(pickBackend({ VERCEL: '1', AI_GATEWAY_URL: 'http://localhost:9/' })).toMatchObject({ baseURL: 'http://localhost:9' });
  });
  it('is off with nothing configured', () => {
    expect(pickBackend({})).toBeNull();
  });
});

describe('canonicalModel', () => {
  it('maps gateway ids to Anthropic ids, so costs price correctly', () => {
    expect(canonicalModel('anthropic/claude-opus-5.5')).toBe('claude-opus-5-5');
    expect(canonicalModel('claude-opus-4-8')).toBe('claude-opus-4-8');
    expect(readCostUsd({ input_tokens: 10_000, output_tokens: 3_000 }, canonicalModel('anthropic/claude-opus-5.5'))).toBe(0.1);
  });
});
