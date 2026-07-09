/**
 * Cifrado simétrico AES-256-GCM para credenciales de integración por tenant.
 *
 * Las credenciales (tokens OAuth, API keys) se guardan cifradas en
 * IntegrationConfig.encryptedCredentials. Nunca en texto plano.
 *
 * Cumplimiento PIPEDA: datos sensibles cifrados en reposo.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { getEnv } from './env.js';

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM recomienda 96 bits (12 bytes)
const TAG_LENGTH = 16;

function getKey(): Buffer {
  const env = getEnv();
  const raw = Buffer.from(env.INTEGRATION_ENCRYPTION_KEY, 'base64');
  if (raw.length !== 32) {
    throw new Error(
      `INTEGRATION_ENCRYPTION_KEY debe decodificar a 32 bytes (AES-256), tiene ${raw.length}`,
    );
  }
  return raw;
}

/**
 * Cifra un texto plano. Devuelve una cadena base64 que contiene
 * IV (12) + ciphertext + tag (16) concatenados.
 */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, tag]).toString('base64');
}

/** Descifra una cadena producida por encrypt(). */
export function decrypt(blob: string): string {
  const data = Buffer.from(blob, 'base64');
  const iv = data.subarray(0, IV_LENGTH);
  const tag = data.subarray(data.length - TAG_LENGTH);
  const ciphertext = data.subarray(IV_LENGTH, data.length - TAG_LENGTH);
  const decipher = createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
