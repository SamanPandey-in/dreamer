import crypto from 'node:crypto';
import { env } from './env';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV — the recommended size for GCM
const KEY = Buffer.from(env.ENCRYPTION_KEY, 'hex'); // 32 bytes = AES-256

interface EncryptedPayload {
  ciphertext: string; // base64
  iv: string; // base64
  authTag: string; // base64
}

/**
 * Encrypts a plaintext string (the raw GitHub access token) before it touches
 * the DB. GCM gives us confidentiality AND integrity — the authTag lets
 * decrypt() detect if the stored ciphertext was ever tampered with.
 */
function encrypt(plaintext: string): EncryptedPayload {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

function decrypt(payload: EncryptedPayload): string {
  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.authTag, 'base64'));

  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'base64')),
    decipher.final(),
  ]);

  return plaintext.toString('utf8');
}

/**
 * User.githubToken is a single TEXT column (unlike EnvVariable, which has
 * separate `value` + `iv` columns) — so we pack iv:authTag:ciphertext into
 * one string. `:` is safe as a delimiter because all three parts are base64
 * (alphabet: A-Z a-z 0-9 + / =) and never contain a literal colon.
 */
export function encryptForStorage(plaintext: string): string {
  const { ciphertext, iv, authTag } = encrypt(plaintext);
  return `${iv}:${authTag}:${ciphertext}`;
}

export function decryptFromStorage(packed: string): string {
  const [iv, authTag, ciphertext] = packed.split(':');
  if (!iv || !authTag || !ciphertext) {
    throw new Error('Malformed encrypted payload');
  }
  return decrypt({ iv, authTag, ciphertext });
}

/**
 *  NEW. EnvVariable and DeploymentEnvSnapshot have separate `value` + `iv`
 * columns (no third column for the auth tag) — so here the IV stays in its
 * own column as-is, and only ciphertext+authTag share `value`, joined by the
 * same `:` delimiter for the same reason as above (both halves are base64,
 * which never contains a literal colon).
 */
export interface ColumnEncryptedPayload {
  value: string; // "ciphertextBase64:authTagBase64"
  iv: string; // ivBase64
}

export function encryptForColumn(plaintext: string): ColumnEncryptedPayload {
  const { ciphertext, iv, authTag } = encrypt(plaintext);
  return { value: `${ciphertext}:${authTag}`, iv };
}

export function decryptFromColumn(payload: ColumnEncryptedPayload): string {
  const [ciphertext, authTag] = payload.value.split(':');
  if (!ciphertext || !authTag) {
    throw new Error('Malformed encrypted column payload');
  }
  return decrypt({ ciphertext, iv: payload.iv, authTag });
}