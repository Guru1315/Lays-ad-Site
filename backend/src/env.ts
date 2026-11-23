/** Bindings and settings the Worker receives from Cloudflare (see wrangler.jsonc). */
export interface Env {
  /** D1 database binding. There is no connection string or password: access is granted by the binding. */
  DB: D1Database;
  /** Workers Rate Limiting binding for write endpoints. */
  WRITE_LIMITER: RateLimit;
  /** Comma-separated list of exact origins allowed to call the API, e.g. "https://guru-lays-site.vercel.app". */
  ALLOWED_ORIGINS: string;
  /** Secret (wrangler secret put): base64 of 32 random bytes, AES-256-GCM key for emails. */
  EMAIL_ENC_KEY: string;
  /** Secret (wrangler secret put): base64 of 32 random bytes, HMAC-SHA-256 key for email lookup hashes. */
  EMAIL_HASH_KEY: string;
}
