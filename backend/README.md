# Crunch Lab API (Cloudflare Workers + D1)

The backend for [guru-lays-site.vercel.app](https://guru-lays-site.vercel.app), live at `https://crunch-lab-api.gurumurugan291.workers.dev`. It handles Join sign-ups, Build-a-Box orders, and profiles with passkey sign-in and order tracking.

| Endpoint | Method | Sign-in | What it does |
|---|---|---|---|
| `/api/health` | GET | | Health check |
| `/api/flavors` | GET | | Public flavor catalog with server-side prices |
| `/api/signups` | POST | | "First dibs" email sign-up (Join section) |
| `/api/orders` | POST | optional | Build-a-Box 3-pack order (demo: nothing is charged). Linked to the buyer when signed in |
| `/api/auth/register/options` · `/verify` | POST | | Create a profile with a passkey |
| `/api/auth/login/options` · `/verify` | POST | | Sign in with a passkey |
| `/api/auth/logout` | POST | | End the session (server-side) |
| `/api/me` | GET | | The signed-in user, or `{ "user": null }` |
| `/api/me` | POST | required | Change display name |
| `/api/me/delete` | POST | required | Delete the profile, its passkeys and sessions |
| `/api/me/orders` | GET | required | Your orders, with items and a status timeline |
| `/api/me/orders/claim` | POST | required | Attach orders placed on this device before signing in |
| `/api/me/orders/:id/cancel` | POST | required | Cancel your own order while it's still "placed" |

Nobody can read another person's data: every profile query is scoped by the user id from the session, never from the request.

```
browser ──▶ guru-lays-site.vercel.app/api/*  (src/proxy.ts on Vercel: adds the visitor IP + shared secret)
                 │
                 ▼  HTTPS
           Worker (src/index.ts)
             ├─ validation.ts   Zod schemas
             ├─ passkeys.ts     WebAuthn via @simplewebauthn/server
             ├─ sessions.ts     HttpOnly cookie, SHA-256-hashed tokens
             ├─ profile.ts      user-scoped queries
             ├─ crypto.ts       AES-GCM + HMAC for emails
             ├─ repo.ts         parameterized SQL only
             └─ env.DB ──binding──▶ D1 (SQLite)
```

The site calls the API on its own domain through a Next.js proxy, so the session is a normal first-party cookie. Browsers block cross-site cookies, so a cookie set directly by `workers.dev` wouldn't work.

## Setup

Requires Node 20+ and a Cloudflare account.

```bash
cd backend
npm install
npx wrangler login

# 1. Create the database, then paste the printed database_id into wrangler.jsonc
npx wrangler d1 create crunch-lab

# 2. Local secrets and settings (git-ignored)
npm run keys                     # prints three fresh keys
cp .dev.vars.example .dev.vars   # paste them in; RP_ID=localhost for local passkeys

# 3. Local database and dev server
npm run db:migrate:local
npm run dev                      # http://localhost:8787
```

To run the site against it locally, start the site with `API_ORIGIN=http://localhost:8787` and `API_PROXY_SECRET=<the PROXY_SECRET from .dev.vars>`, and list the site's local origin in both `ALLOWED_ORIGINS` and `RP_ORIGINS`.

## Deploy

```bash
npm run check                     # typecheck + tests + npm audit
npm run keys                      # generate NEW keys for production (don't reuse local ones)
npx wrangler secret put EMAIL_ENC_KEY
npx wrangler secret put EMAIL_HASH_KEY
npx wrangler secret put PROXY_SECRET
npm run db:migrate:remote
npm run deploy
```

In Vercel (the site), set `API_ORIGIN` to the Worker URL and `API_PROXY_SECRET` to the same value as `PROXY_SECRET`, marked **Sensitive**. Both are server-only: neither has a `NEXT_PUBLIC_` prefix.

**Back up your keys.** Store `EMAIL_ENC_KEY` and `EMAIL_HASH_KEY` in a password manager. Without `EMAIL_ENC_KEY`, stored emails can't be decrypted. `PROXY_SECRET` can be rotated any time: set a new value in both places.

## Updating an order's status (owner only)

```bash
npm run order:status -- <order-id> packed      # or shipped, delivered, cancelled; add --local for the dev DB
```

The buyer sees the change on their profile's tracking timeline. The script checks that the id is a UUID and the status is one of the allowed values.

## Security review

| Requirement | How it's handled here |
|---|---|
| **Secrets in env vars, never in code** | Secrets are `EMAIL_ENC_KEY`, `EMAIL_HASH_KEY` and `PROXY_SECRET`, set with `wrangler secret put` (prod) or `.dev.vars` (local, git-ignored). D1 has **no connection string or DB password**: the Worker reaches it through the `DB` binding, so there is nothing to leak. Values in `vitest.config.ts` are test-only. |
| **Authentication** | **Passkeys** (WebAuthn). There are no passwords to store, leak or phish. The server keeps only each passkey's public key and verifies a signature over a random, single-use challenge that expires after 5 minutes. Passkeys are bound to `guru-lays-site.vercel.app`, so a look-alike site can't use them (tested). Sign-in uses one generic error for "unknown passkey" and "bad signature". |
| **Sessions** | A random 256-bit token in a `__Host-` cookie with `HttpOnly; Secure; SameSite=Lax; Path=/`, so page JavaScript can't read it and other sites can't send it on POSTs. The database stores only its SHA-256 hash. Sessions last 30 days and sign-out deletes them on the server. |
| **Authorization (RLS equivalent)** | D1 is SQLite and has **no RLS**, so the Worker enforces it. Every profile query includes `WHERE user_id = ?` with the id from the session, never from the request body. Tests check that one user can't see or cancel another's order. There's no endpoint that lists sign-ups or other people's orders. |
| **SQL injection** | Every query is a constant string with `?` placeholders and `.bind()` values. The only dynamic part is the number of `?` in the claim query. Tests send `DROP TABLE`, `' OR 1=1 --` and malformed cookies and ids, and check nothing changes. |
| **Least privilege** | D1 has no database roles, so privilege is limited at each layer. The Worker never runs DDL. Its only `UPDATE`s are scoped by `user_id` (order status, owner, display name), plus passkey counters and rate-limit counters. Its `DELETE`s cover used challenges, your own session or profile, and expired rows. Schema changes live in `migrations/` and are applied by you. For CI deploys, use a Cloudflare API token limited to **Workers Scripts: Edit** and **D1: Edit**. |
| **PII protection** | Emails are encrypted with AES-256-GCM before storage, with an HMAC lookup hash for de-duplication. Profiles hold only an optional display name. IP addresses are used only as rate-limit keys (HMAC-hashed) and are never stored. |
| **Backend validation** | Zod schemas in [`src/validation.ts`](src/validation.ts) check type, length and format, and reject unknown fields. Display names are 1–40 printable characters, with control and invisible characters rejected. Bodies are capped at 2 KB (16 KB for passkey payloads). Prices come from the `flavors` table. Table `CHECK` constraints and foreign keys back this up. |
| **XSS** | JSON only, with `nosniff` and `Content-Security-Policy: default-src 'none'`. Errors never echo input. The site renders names and orders as React text, never as HTML. |
| **HTTPS / TLS** | Vercel and `*.workers.dev` serve HTTPS only, and the API sends HSTS. The Worker-to-D1 link is internal to Cloudflare and encrypted. |
| **Rate limiting** | Two layers, 5 writes/minute per IP per endpoint: the Workers Rate Limiting binding (fast, approximate) and an exact D1 counter. Behind the proxy, the Worker uses the real visitor IP only when the request carries `PROXY_SECRET`, checked in constant time. Otherwise it uses Cloudflare's connecting IP, so a spoofed `X-Client-IP` is ignored (tested). |
| **CORS / CSRF** | Exact-match origin allowlist. POSTs with a missing or foreign `Origin` get `403`, and non-JSON bodies get `415`. The session cookie is `SameSite=Lax`, so cross-site requests don't carry it. A CSRF test checks that a profile change from another site is refused even with a valid cookie. |
| **Enumeration** | Re-signing up with a listed email returns the same answer as a new one, and passkey sign-in errors don't reveal whether a passkey exists. |
| **Backups** | D1 **Time Travel** is always on: restore to any minute in the last 30 days with `npx wrangler d1 time-travel restore crunch-lab --timestamp=<ISO time>`. For longer retention, run `npx wrangler d1 export crunch-lab --remote --output=backup.sql` on a schedule and store it privately. |
| **Dependencies** | `npm run check` includes `npm audit`. Dependabot opens weekly update PRs, and CI runs the checks on every push. |
| **Errors** | Internal errors are logged server-side with a request id. Clients only see a generic message. |

## Data model

```
users (id PK, display_name, created_at)
  ├─ passkeys (credential_id PK, user_id FK CASCADE, public_key, counter, transports, device_type, backed_up)
  ├─ sessions (token_hash PK, user_id FK CASCADE, created_at, expires_at)
  └─ orders (id PK, user_id FK SET NULL, subtotal/discount/total_cents, status, created_at)
       ├─ order_items (order_id FK CASCADE, slot 0–2, flavor_id FK ─▶ flavors RESTRICT, unit_price_cents)
       └─ order_events (order_id FK CASCADE, status, at)   ← tracking timeline
flavors (id PK, name, price_cents, active)
signups (id PK, email_hash UNIQUE, email_ciphertext, email_iv, key_version, consent = 1, created_at)
auth_challenges (id PK, challenge, purpose, user_handle, display_name, expires_at)   ← single-use, 5 min
rate_limits (bucket = HMAC(route + IP), window_start, hits)
```

Order statuses: `placed → packed → shipped → delivered`, or `cancelled`.

## Reading your data (owner only)

```bash
npx wrangler d1 execute crunch-lab --remote --command "SELECT id, status, total_cents, created_at FROM orders ORDER BY created_at DESC LIMIT 20"
```

Emails are encrypted in the DB. To export them for a mailing, write a small one-off script that runs `decrypt()` from `src/crypto.ts` with the production key, and keep the output off GitHub.

## Tests

```bash
npm test
```

39 tests run against a real local D1 and rate limiter via `@cloudflare/vitest-plugin`. A software authenticator in [`test/softAuthenticator.ts`](test/softAuthenticator.ts) produces genuine signed passkey responses, so the real verification code runs. Coverage includes:
- passkey sign-up and sign-in
- replayed challenges and phishing origins
- cookie flags and hashed sessions
- sign-out, CSRF, and one user not seeing another's orders
- cancelling and claiming orders
- spoofed proxy headers
- origin and CORS checks, validation, SQL-injection payloads
- emails encrypted at rest, server-side pricing, rate limiting

## Privacy note

This is a fan concept and isn't affiliated with Lay's or PepsiCo. The Join form says so and asks for consent. Profiles hold no email, and you can delete yours at any time from the profile panel.
