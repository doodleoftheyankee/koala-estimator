import { describe, expect, it } from 'vitest';
import { num, pct, timeAgo, usd } from './format';

describe('format', () => {
  it('formats money, percent and numbers', () => {
    expect(usd(5420)).toBe('$5,420');
    expect(usd(5420.5, true)).toBe('$5,420.50');
    expect(pct(0.4005)).toBe('40.1%');
    expect(num(1234.567, 1)).toBe('1,234.6');
  });
  it('describes elapsed time', () => {
    const now = Date.parse('2026-10-20T12:00:00Z');
    expect(timeAgo('2026-10-20T11:59:30Z', now)).toBe('just now');
    expect(timeAgo('2026-10-20T11:45:00Z', now)).toBe('15 min ago');
    expect(timeAgo('2026-10-20T09:00:00Z', now)).toBe('3 h ago');
    expect(timeAgo('2026-10-19T09:00:00Z', now)).toBe('yesterday');
    expect(timeAgo('2026-10-15T09:00:00Z', now)).toBe('5 days ago');
  });
});
