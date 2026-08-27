import '../../setup/test-env';
import { describe, it, expect } from 'vitest';
import {
  encryptForStorage,
  decryptFromStorage,
  encryptForColumn,
  decryptFromColumn,
} from '@api/lib/crypto';

describe('crypto — single-column storage (User.githubToken-style)', () => {
  it('round-trips a plaintext value through encrypt -> decrypt unchanged', () => {
    const plaintext = 'ghu_supersecretGithubAccessToken1234567890';
    const packed = encryptForStorage(plaintext);
    expect(decryptFromStorage(packed)).toBe(plaintext);
  });

  it('never stores the plaintext verbatim in the packed ciphertext', () => {
    const plaintext = 'a-very-recognizable-secret-value';
    const packed = encryptForStorage(plaintext);
    expect(packed).not.toContain(plaintext);
  });

  it('produces a different ciphertext for the same plaintext on every call (random IV)', () => {
    const plaintext = 'same-secret-both-times';
    const first = encryptForStorage(plaintext);
    const second = encryptForStorage(plaintext);
    expect(first).not.toBe(second);
    expect(decryptFromStorage(first)).toBe(plaintext);
    expect(decryptFromStorage(second)).toBe(plaintext);
  });

  it('packs exactly three colon-delimited base64 segments (iv:authTag:ciphertext)', () => {
    const packed = encryptForStorage('anything');
    expect(packed.split(':')).toHaveLength(3);
  });

  it('throws on a malformed packed payload instead of returning garbage', () => {
    expect(() => decryptFromStorage('not-even-close-to-valid')).toThrow('Malformed encrypted payload');
    expect(() => decryptFromStorage('only:two')).toThrow('Malformed encrypted payload');
  });

  it('throws if the ciphertext has been tampered with', () => {
    const packed = encryptForStorage('untampered-secret');
    const [iv, authTag, ciphertext] = packed.split(':');
    const tampered = `${iv}:${authTag}:${Buffer.from(ciphertext, 'base64').reverse().toString('base64')}`;
    expect(() => decryptFromStorage(tampered)).toThrow();
  });
});

describe('crypto — two-column storage (EnvVariable-style: value + iv columns)', () => {
  it('round-trips a plaintext env var value through encrypt -> decrypt unchanged', () => {
    const plaintext = 'DATABASE_PASSWORD=hunter2';
    const { value, iv } = encryptForColumn(plaintext);
    expect(decryptFromColumn({ value, iv })).toBe(plaintext);
  });

  it('stores ciphertext and authTag joined by ":" in the value column, IV separate', () => {
    const { value, iv } = encryptForColumn('some-env-value');
    expect(value.split(':')).toHaveLength(2);
    expect(iv.length).toBeGreaterThan(0);
  });

  it('throws on a malformed column payload', () => {
    expect(() => decryptFromColumn({ value: 'no-colon-here', iv: 'irrelevant' })).toThrow(
      'Malformed encrypted column payload'
    );
  });

  it('is not decryptable with a mismatched iv from a different encryption call', () => {
    const first = encryptForColumn('secret-one');
    const second = encryptForColumn('secret-two');
    expect(() => decryptFromColumn({ value: first.value, iv: second.iv })).toThrow();
  });
});
