// @vitest-environment node
// Set-password invitation links (worker/src/setPasswordToken.ts).
import { describe, it, expect } from 'vitest';
import {
  SET_PASSWORD_TTL_S,
  readSetPasswordToken,
  setPasswordTokenValid,
  signSetPasswordToken,
} from '../../../worker/src/setPasswordToken';

const SECRET = 'test-secret-that-is-not-used-anywhere';
const USER = '0b6f3b1e-1111-4222-8333-944455556666';
const NOW = Date.UTC(2026, 9, 1, 8, 0, 0);

describe('set-password tokens', () => {
  it('verifies a fresh token for the same password hash', async () => {
    const token = await signSetPasswordToken(SECRET, USER, null, NOW);
    const parsed = readSetPasswordToken(token);
    expect(parsed?.userId).toBe(USER);
    expect(parsed?.exp).toBe(NOW / 1000 + SET_PASSWORD_TTL_S);
    expect(await setPasswordTokenValid(SECRET, parsed!, null, NOW + 1000)).toBe(true);
  });

  it('dies once the password changes (single use)', async () => {
    const token = readSetPasswordToken(await signSetPasswordToken(SECRET, USER, null, NOW))!;
    expect(await setPasswordTokenValid(SECRET, token, 'pbkdf2$100000$c2FsdA==$aGFzaA==', NOW)).toBe(false);
  });

  it('expires after the TTL', async () => {
    const token = readSetPasswordToken(await signSetPasswordToken(SECRET, USER, 'h', NOW))!;
    expect(await setPasswordTokenValid(SECRET, token, 'h', NOW + SET_PASSWORD_TTL_S * 1000 - 1)).toBe(true);
    expect(await setPasswordTokenValid(SECRET, token, 'h', NOW + SET_PASSWORD_TTL_S * 1000)).toBe(false);
  });

  it('rejects another secret, another user and malformed tokens', async () => {
    const raw = await signSetPasswordToken(SECRET, USER, 'h', NOW);
    const token = readSetPasswordToken(raw)!;
    expect(await setPasswordTokenValid('another-secret', token, 'h', NOW)).toBe(false);
    expect(await setPasswordTokenValid(SECRET, { ...token, userId: 'someone-else' }, 'h', NOW)).toBe(false);
    expect(readSetPasswordToken(raw.replace('v1.', 'v2.'))).toBeNull();
    expect(readSetPasswordToken('v1.user.123.not-hex')).toBeNull();
    expect(readSetPasswordToken('v1.a.b.c.d')).toBeNull();
    expect(readSetPasswordToken(42)).toBeNull();
  });
});
