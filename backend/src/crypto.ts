/**
 * Field-level protection for PII (email addresses), using the Web Crypto API built into Workers.
 * - encrypt/decrypt: AES-256-GCM with a random 96-bit IV per value.
 * - lookupHash: HMAC-SHA-256, so the same email always maps to the same hash for de-duplication,
 *   but the hash cannot be reversed or brute-forced without the secret key.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

export const KEY_VERSION = 1;

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Decodes a base64 secret and insists on exactly 32 bytes, so a weak or missing key fails closed. */
function keyBytes(b64: string | undefined, name: string): Uint8Array<ArrayBuffer> {
  if (!b64) throw new ConfigError(`${name} is not set`);
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = fromBase64(b64.trim());
  } catch {
    throw new ConfigError(`${name} is not valid base64`);
  }
  if (bytes.length !== 32) throw new ConfigError(`${name} must be 32 bytes`);
  return bytes;
}

export class ConfigError extends Error {}

export interface PiiKeys {
  aes: CryptoKey;
  hmac: CryptoKey;
}

export async function importKeys(encKeyB64: string | undefined, hashKeyB64: string | undefined): Promise<PiiKeys> {
  const aes = await crypto.subtle.importKey("raw", keyBytes(encKeyB64, "EMAIL_ENC_KEY"), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
  const hmac = await crypto.subtle.importKey(
    "raw",
    keyBytes(hashKeyB64, "EMAIL_HASH_KEY"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return { aes, hmac };
}

export async function encrypt(keys: PiiKeys, plaintext: string): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, keys.aes, enc.encode(plaintext));
  return { ciphertext: toBase64(new Uint8Array(ct)), iv: toBase64(iv) };
}

export async function decrypt(keys: PiiKeys, ciphertext: string, iv: string): Promise<string> {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(iv) }, keys.aes, fromBase64(ciphertext));
  return dec.decode(pt);
}

export async function lookupHash(keys: PiiKeys, value: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", keys.hmac, enc.encode(value));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
