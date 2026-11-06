import { describe, expect, it } from 'vitest';
import { formatUsdc6, isWorldConfig } from '../src/client.ts';

describe('browser helpers', () => {
  it('formats 6-decimal USDC and shows "—" for a missing or non-numeric value instead of throwing', () => {
    expect(formatUsdc6('25000000')).toBe('25');
    expect(formatUsdc6(1_500_000n)).toBe('1.50');
    expect(formatUsdc6(undefined)).toBe('—');
    expect(formatUsdc6(null)).toBe('—');
    expect(formatUsdc6('')).toBe('—');
    expect(formatUsdc6('abc')).toBe('—');
  });

  it('accepts a real /world-id/config body and rejects a 404 body from a server without the World ID routes', () => {
    expect(isWorldConfig({ error: 'Not found' })).toBe(false);
    expect(isWorldConfig(null)).toBe(false);
    expect(isWorldConfig({ configured: false, missing: ['WORLD_APP_ID'], starterLimitUsdc6: '25000000' })).toBe(true);
  });
});
