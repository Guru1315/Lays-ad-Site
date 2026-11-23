# Crunch Lab API (Cloudflare Workers + D1)

The backend for [guru-lays-site.vercel.app](https://guru-lays-site.vercel.app). It saves two things:

| Endpoint | Method | What it does |
|---|---|---|
| `/api/signups` | POST | "First dibs" email sign-up (Join section) |
| `/api/orders` | POST | Build-a-Box 3-pack order (demo: nothing is charged) |
| `/api/flavors` | GET | Public flavor catalog with server-side prices |
| `/api/health` | GET | Health check |

There is no public endpoint that reads sign-ups or orders back. Only the owner can see them, from the Cloudflare dashboard or with `wrangler d1 execute`.

```
frontend (Vercel, Next.js) ──HTTPS + Origin check──▶ Worker (src/index.ts)
                                                     ├─ validation.ts   Zod schemas
                                                     ├─ crypto.ts       AES-GCM + HMAC for emails
                                                     ├─ repo.ts         parameterized SQL only
                                                     └─ env.DB  ──binding──▶  D1 (SQLite)
```

## Setup

Requires Node 20+ and a Cloudflare account.

```bash
cd backend
npm install
npx wrangler login

# 1. Create the database, then paste the printed database_id into wrangler.jsonc
npx wrangler d1 create crunch-lab

# 2. Local secrets (git-ignored)
npm run keys            # prints two fresh keys
cp .dev.vars.example .dev.vars   # paste the keys in

# 3. Local database and dev server
npm run db:migrate:local
npm run dev             # http://localhost:8787
```

For local frontend work, add `http://localhost:3000` to `ALLOWED_ORIGINS` (in `.dev.vars` or in a local `wrangler.jsonc` edit you don't commit).

## Deploy

```bash
npm run check                     # typecheck + tests + npm audit
npm run keys                      # generate NEW keys for production (don't reuse local ones)
npx wrangler secret put EMAIL_ENC_KEY
npx wrangler secret put EMAIL_HASH_KEY
npm run db:migrate:remote
npm run deploy
```

Then, in Vercel, set `NEXT_PUBLIC_API_URL` to the Worker URL and copy [`client/crunchLabApi.ts`](client/crunchLabApi.ts) into the site (`src/lib/`). Call `joinList()` from the Join form and `placeBoxOrder()` from checkout, and add a visually hidden `website` input to the Join form as a honeypot.

**Back up your keys.** Store `EMAIL_ENC_KEY` and `EMAIL_HASH_KEY` in a password manager. Without `EMAIL_ENC_KEY`, stored emails can't be decrypted.

## Security review

| Requirement | How it's handled here |
|---|---|
| **Secrets in env vars, never in code** | The only secrets are `EMAIL_ENC_KEY` and `EMAIL_HASH_KEY`, set with `wrangler secret put` (prod) or `.dev.vars` (local, git-ignored). D1 has **no connection string or DB password**: the Worker reaches it through the `DB` binding, so there is nothing to leak. The keys in `vitest.config.ts` are test-only values. |
| **Row Level Security** | D1 is SQLite and has **no RLS**. The same protection comes from the Worker being the only way in: no endpoint lists or reads sign-ups or orders, writes are insert-only, and order ids are random UUIDs. D1 isn't reachable from the internet except through the Cloudflare API with your account token. |
| **SQL injection** | Every query in [`src/repo.ts`](src/repo.ts) is a constant string with `?` placeholders and `.bind()` values. No string-built SQL. Tests post `DROP TABLE` and `' OR 1=1 --` payloads and check nothing changes. |
| **Least privilege** | D1 has no database roles, so privilege is limited at each layer. The Worker code only runs `SELECT` and `INSERT` (no `UPDATE`/`DELETE`/DDL). Schema changes live in `migrations/` and are applied by you with wrangler. For CI deploys, create a Cloudflare API token scoped to *this account* with only **Workers Scripts: Edit** and **D1: Edit**, instead of using a global key. |
| **Passwords** | The site has no user accounts or logins, so no passwords are stored. If you add accounts later, use an auth service (e.g. Cloudflare Access, Clerk, Auth.js) that hashes with Argon2/bcrypt. Never store passwords yourself. |
| **PII protection** | Emails are encrypted with AES-256-GCM (random IV per row) before storage. De-duplication uses a keyed HMAC-SHA-256 hash, so a leaked DB copy reveals no addresses. IP addresses are used only as rate-limit keys and are never stored. |
| **Backend validation** | Zod schemas in [`src/validation.ts`](src/validation.ts) check type, length and format. They're `.strict()`, so unknown fields (like `isAdmin` or a client `totalCents`) are rejected. Bodies are capped at 2 KB. Prices come from the `flavors` table, never from the browser. Table `CHECK` constraints and foreign keys back this up in the database. |
| **XSS** | The API returns JSON only, with `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'`. Error messages never echo input back. In the frontend, render values as text (React does this by default) and never use `dangerouslySetInnerHTML` with API data. |
| **HTTPS / TLS** | Vercel and `*.workers.dev` serve HTTPS only, and the API sends HSTS. The Worker-to-D1 link runs inside Cloudflare's network and is encrypted automatically. There's no client-side DB connection to configure. |
| **Rate limiting** | Workers Rate Limiting binding: 5 writes/minute per IP per endpoint, returning `429` with `Retry-After`. Signups also have a honeypot field. For extra protection, add [Turnstile](https://developers.cloudflare.com/turnstile/) to the Join form. |
| **CORS / CSRF** | Exact-match origin allowlist (`ALLOWED_ORIGINS`). POSTs with a missing or foreign `Origin` are rejected with `403`, and non-JSON bodies with `415`, so cross-site HTML forms can't post. No cookies are used, so there's no session to hijack. |
| **Enumeration** | Signing up with an email that's already on the list returns the same response as a new sign-up. |
| **Backups** | D1 **Time Travel** is always on: restore to any minute in the last 30 days with `npx wrangler d1 time-travel restore crunch-lab --timestamp=<ISO time>`. For longer retention, run `npx wrangler d1 export crunch-lab --remote --output=backup.sql` on a schedule and store the file privately (it contains only encrypted emails). |
| **Dependencies** | `npm run check` includes `npm audit`. Dependabot (`.github/dependabot.yml`) opens weekly update PRs, and CI runs the checks on every push. |
| **Errors** | Internal errors are logged server-side with a request id. Clients only see a generic message. |

## Data model

```
flavors (id PK, name, price_cents, active)
   ▲
   │ RESTRICT
order_items (order_id FK ─▶ orders.id ON DELETE CASCADE, slot 0–2, flavor_id FK, unit_price_cents)
orders (id PK, subtotal_cents, discount_cents, total_cents = subtotal − discount, status, created_at)
signups (id PK, email_hash UNIQUE, email_ciphertext, email_iv, key_version, consent = 1, created_at)
```

## Reading your data (owner only)

```bash
npx wrangler d1 execute crunch-lab --remote --command "SELECT id, total_cents, created_at FROM orders ORDER BY created_at DESC LIMIT 20"
```

Emails are encrypted in the DB. To export them for a mailing, write a small one-off script that runs `decrypt()` from `src/crypto.ts` with the production key, and keep the output off GitHub.

## Tests

```bash
npm test
```

20 tests run against a real local D1 and rate limiter via `@cloudflare/vitest-plugin`. They cover origin and CORS checks, content type, body size, Zod validation, SQL-injection payloads, that emails are encrypted at rest, duplicate-email handling, the honeypot, server-side pricing, rate limiting, and failing closed on bad keys.

## Privacy note

This is a fan concept and isn't affiliated with Lay's or PepsiCo. Once the Join form stores real emails, say so next to the form, link a short privacy note (what you collect, why, how to be removed), and only email people who ticked consent.
