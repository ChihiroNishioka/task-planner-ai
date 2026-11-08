import { describe, expect, it } from 'vitest';
import { createSessionToken, isValidSessionToken } from '../src/domain/session';

describe('署名付きセッション', () => {
  it('メールと期限を署名し、期限切れ・改ざん・許可解除を拒否する', () => {
    const now = Date.parse('2026-11-08T00:00:00.000Z');
    const token = createSessionToken('s'.repeat(48), 'owner@example.com', now);
    expect(isValidSessionToken(token, 's'.repeat(48), 'owner@example.com', now)).toBe(true);
    expect(isValidSessionToken(`${token}x`, 's'.repeat(48), 'owner@example.com', now)).toBe(false);
    expect(isValidSessionToken(token, 's'.repeat(48), 'owner@example.com', now + 13 * 60 * 60 * 1000)).toBe(false);
    expect(isValidSessionToken(token, 's'.repeat(48), 'other@example.com', now)).toBe(false);
  });
});
