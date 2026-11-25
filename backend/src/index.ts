import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { ConfigError, encrypt, importKeys, KEY_VERSION, lookupHash } from "./crypto";
import type { Env } from "./env";
import { corsHeaders, error, json, parseAllowedOrigins, readJson } from "./http";
import {
  authenticationOptions,
  PasskeyError,
  registrationOptions,
  relyingParty,
  verifyAuthentication,
  verifyRegistration,
} from "./passkeys";
import { cancelOrder, claimOrders, deleteAccount, listOrders, updateDisplayName } from "./profile";
import { hitRateLimit, insertOrder, insertSignup, listActiveFlavors, priceBox } from "./repo";
import { clearSessionCookie, createSession, deleteSession, getSessionUser, type SessionUser } from "./sessions";
import {
  claimSchema,
  emptySchema,
  fieldErrors,
  loginVerifySchema,
  MAX_AUTH_BODY_BYTES,
  MAX_BODY_BYTES,
  orderSchema,
  profileUpdateSchema,
  registerOptionsSchema,
  registerVerifySchema,
  signupSchema,
} from "./validation";

/** Writes allowed per client IP, per endpoint, per window. */
const RATE_LIMIT_PER_WINDOW = 5;
const RATE_WINDOW_SECONDS = 60;

type Ctx = {
  request: Request;
  env: Env;
  cors: Record<string, string>;
  params: Record<string, string>;
  /** The signed-in user; always set for routes marked `auth: true`. */
  user: SessionUser | null;
};
type Handler = (ctx: Ctx) => Promise<Response>;
type Route = {
  name: string;
  method: "GET" | "POST";
  path: string | RegExp;
  handler: Handler;
  /** Reject with 401 unless there's a valid session. */
  auth?: boolean;
};

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

const routes: Route[] = [
  { name: "health", method: "GET", path: "/api/health", handler: async ({ cors }) => json(200, { ok: true }, cors) },
  { name: "flavors", method: "GET", path: "/api/flavors", handler: handleFlavors },
  { name: "signups", method: "POST", path: "/api/signups", handler: handleSignup },
  { name: "orders", method: "POST", path: "/api/orders", handler: handleOrder },

  { name: "register-options", method: "POST", path: "/api/auth/register/options", handler: handleRegisterOptions },
  { name: "register-verify", method: "POST", path: "/api/auth/register/verify", handler: handleRegisterVerify },
  { name: "login-options", method: "POST", path: "/api/auth/login/options", handler: handleLoginOptions },
  { name: "login-verify", method: "POST", path: "/api/auth/login/verify", handler: handleLoginVerify },
  { name: "logout", method: "POST", path: "/api/auth/logout", handler: handleLogout },

  // Answers { user: null } when signed out (not 401), so checking the session is never an error.
  { name: "me", method: "GET", path: "/api/me", handler: handleMe },
  { name: "me-update", method: "POST", path: "/api/me", handler: handleMeUpdate, auth: true },
  { name: "me-delete", method: "POST", path: "/api/me/delete", handler: handleMeDelete, auth: true },
  { name: "my-orders", method: "GET", path: "/api/me/orders", handler: handleMyOrders, auth: true },
  { name: "claim-orders", method: "POST", path: "/api/me/orders/claim", handler: handleClaim, auth: true },
  {
    name: "cancel-order",
    method: "POST",
    path: new RegExp(`^/api/me/orders/(?<orderId>${UUID})/cancel$`),
    handler: handleCancel,
    auth: true,
  },
];

function match(route: Route, pathname: string): Record<string, string> | null {
  if (typeof route.path === "string") return route.path === pathname ? {} : null;
  const m = route.path.exec(pathname);
  return m ? { ...m.groups } : null;
}

/** Constant-time string comparison, so the proxy secret can't be guessed byte by byte. */
function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.byteLength !== eb.byteLength) return false;
  return crypto.subtle.timingSafeEqual(ea, eb);
}

/**
 * The visitor's IP for rate limiting. Requests that come through the site's /api proxy carry
 * the proxy secret plus the real client IP; anything else uses Cloudflare's connecting IP.
 */
function clientIp(request: Request, env: Env): string {
  const proxied = request.headers.get("X-Proxy-Auth");
  if (env.PROXY_SECRET && proxied && safeEqual(proxied, env.PROXY_SECRET)) {
    const ip = request.headers.get("X-Client-IP") ?? "";
    if (/^[0-9a-fA-F.:]{3,45}$/.test(ip)) return ip;
  }
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const allowed = parseAllowedOrigins(env.ALLOWED_ORIGINS);
    const cors = corsHeaders(origin, allowed);

    const candidates = routes.flatMap((r) => {
      const params = match(r, url.pathname);
      return params ? [{ route: r, params }] : [];
    });
    if (candidates.length === 0) return error(404, "not_found", "Not found", cors);

    if (request.method === "OPTIONS") {
      if (!origin || !allowed.has(origin)) return error(403, "origin_not_allowed", "Origin not allowed", cors);
      return new Response(null, { status: 204, headers: cors });
    }

    const hit = candidates.find((c) => c.route.method === request.method);
    if (!hit) {
      const allow = [...new Set(candidates.map((c) => c.route.method)), "OPTIONS"].join(", ");
      return error(405, "method_not_allowed", "Method not allowed", { ...cors, Allow: allow });
    }
    const { route, params } = hit;

    if (route.method === "POST") {
      // Writes are only accepted from the site itself. Browsers always send Origin on POST,
      // so a missing or foreign Origin means another site or a script (CSRF / spam).
      if (!origin || !allowed.has(origin)) return error(403, "origin_not_allowed", "Origin not allowed", cors);

      // Requiring application/json forces a CORS preflight, so plain HTML forms on other sites can't post here.
      const type = request.headers.get("Content-Type") ?? "";
      if (!/^application\/json(\s*;|$)/i.test(type)) {
        return error(415, "unsupported_media_type", "Send JSON", cors);
      }
    }

    try {
      if (route.method === "POST") {
        const ip = clientIp(request, env);
        const tooMany = () =>
          error(429, "rate_limited", "Too many requests. Try again in a minute.", { ...cors, "Retry-After": "60" });

        // Layer 1: Cloudflare's binding. Fast and free, but approximate and per-location.
        const { success } = await env.WRITE_LIMITER.limit({ key: `${route.name}:${ip}` });
        if (!success) return tooMany();

        // Layer 2: exact count in D1, keyed by an HMAC of route + IP so raw IPs are never stored.
        const keys = await importKeys(env.EMAIL_ENC_KEY, env.EMAIL_HASH_KEY);
        const bucket = await lookupHash(keys, `rl:${route.name}:${ip}`);
        if ((await hitRateLimit(env.DB, bucket, RATE_WINDOW_SECONDS)) > RATE_LIMIT_PER_WINDOW) return tooMany();
      }

      const user = await getSessionUser(env.DB, request);
      if (route.auth && !user) return error(401, "unauthenticated", "Sign in to see your profile", cors);

      return await route.handler({ request, env, cors, params, user });
    } catch (err) {
      if (err instanceof PasskeyError) return error(err.status, "passkey_failed", err.message, cors);
      // Log the detail server-side only; the client gets a generic message.
      const requestId = crypto.randomUUID();
      console.error(JSON.stringify({ requestId, path: url.pathname, error: String(err) }));
      if (err instanceof ConfigError) return error(500, "server_misconfigured", "Server is not configured", cors);
      return error(500, "internal_error", "Something went wrong", { ...cors, "X-Request-Id": requestId });
    }
  },
} satisfies ExportedHandler<Env>;

/** Reads and validates a JSON body, or returns the error response to send. */
async function parseBody<T>(
  request: Request,
  cors: Record<string, string>,
  schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: import("zod").ZodError } },
  maxBytes = MAX_BODY_BYTES,
  message = "Check the form",
): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
  const body = await readJson(request, maxBytes);
  if (!body.ok) return { ok: false, response: badBody(body.status, cors) };
  const parsed = schema.safeParse(body.value);
  if (!parsed.success) {
    return { ok: false, response: error(422, "invalid_input", message, cors, fieldErrors(parsed.error)) };
  }
  return { ok: true, data: parsed.data };
}

async function handleFlavors({ env, cors }: Ctx): Promise<Response> {
  const flavors = await listActiveFlavors(env.DB);
  return json(200, { flavors }, { ...cors, "Cache-Control": "public, max-age=300" });
}

async function handleSignup({ request, env, cors }: Ctx): Promise<Response> {
  const body = await parseBody(request, cors, signupSchema);
  if (!body.ok) return body.response;

  // Bots fill the hidden field; answer as if it worked but store nothing.
  if (body.data.website) return json(201, { ok: true }, cors);

  const keys = await importKeys(env.EMAIL_ENC_KEY, env.EMAIL_HASH_KEY);
  const emailHash = await lookupHash(keys, body.data.email);
  const { ciphertext, iv } = await encrypt(keys, body.data.email);
  await insertSignup(env.DB, { emailHash, ciphertext, iv, keyVersion: KEY_VERSION });

  // Same answer whether the email was new or already listed, so the API can't be used to test who signed up.
  return json(201, { ok: true }, cors);
}

async function handleOrder({ request, env, cors, user }: Ctx): Promise<Response> {
  const body = await parseBody(request, cors, orderSchema, MAX_BODY_BYTES, "Check your box");
  if (!body.ok) return body.response;

  const priced = priceBox(body.data.items, await listActiveFlavors(env.DB));
  if (!priced) return error(422, "invalid_input", "Check your box", cors, { items: "Unknown flavor" });

  // Signed-in buyers own the order; guests can claim it later from the same browser.
  const order = await insertOrder(env.DB, priced, user?.id ?? null);
  return json(201, { order, tracked: !!user }, cors);
}

function requireRp(env: Env) {
  const rp = relyingParty(env);
  if (!rp) throw new ConfigError("RP_ID / RP_ORIGINS are not set");
  return rp;
}

async function handleRegisterOptions({ request, env, cors }: Ctx): Promise<Response> {
  const body = await parseBody(request, cors, registerOptionsSchema);
  if (!body.ok) return body.response;
  const result = await registrationOptions(env.DB, requireRp(env), body.data.displayName ?? null);
  return json(200, result, cors);
}

async function handleRegisterVerify({ request, env, cors }: Ctx): Promise<Response> {
  const body = await parseBody(request, cors, registerVerifySchema, MAX_AUTH_BODY_BYTES, "Passkey response was malformed");
  if (!body.ok) return body.response;
  const userId = await verifyRegistration(
    env.DB,
    requireRp(env),
    body.data.challengeId,
    body.data.response as unknown as RegistrationResponseJSON,
  );
  const cookie = await createSession(env.DB, userId);
  return json(201, { ok: true }, { ...cors, "Set-Cookie": cookie });
}

async function handleLoginOptions({ request, env, cors }: Ctx): Promise<Response> {
  const body = await parseBody(request, cors, emptySchema);
  if (!body.ok) return body.response;
  return json(200, await authenticationOptions(env.DB, requireRp(env)), cors);
}

async function handleLoginVerify({ request, env, cors }: Ctx): Promise<Response> {
  const body = await parseBody(request, cors, loginVerifySchema, MAX_AUTH_BODY_BYTES, "Passkey response was malformed");
  if (!body.ok) return body.response;
  const userId = await verifyAuthentication(
    env.DB,
    requireRp(env),
    body.data.challengeId,
    body.data.response as unknown as AuthenticationResponseJSON,
  );
  const cookie = await createSession(env.DB, userId);
  return json(200, { ok: true }, { ...cors, "Set-Cookie": cookie });
}

async function handleLogout({ request, env, cors }: Ctx): Promise<Response> {
  await deleteSession(env.DB, request);
  return json(200, { ok: true }, { ...cors, "Set-Cookie": clearSessionCookie() });
}

async function handleMe({ cors, user }: Ctx): Promise<Response> {
  return json(200, { user }, cors);
}

async function handleMeUpdate({ request, env, cors, user }: Ctx): Promise<Response> {
  const body = await parseBody(request, cors, profileUpdateSchema);
  if (!body.ok) return body.response;
  await updateDisplayName(env.DB, user!.id, body.data.displayName);
  return json(200, { user: { ...user!, displayName: body.data.displayName } }, cors);
}

async function handleMeDelete({ request, env, cors, user }: Ctx): Promise<Response> {
  const body = await parseBody(request, cors, emptySchema);
  if (!body.ok) return body.response;
  await deleteAccount(env.DB, user!.id);
  return json(200, { ok: true }, { ...cors, "Set-Cookie": clearSessionCookie() });
}

async function handleMyOrders({ env, cors, user }: Ctx): Promise<Response> {
  return json(200, { orders: await listOrders(env.DB, user!.id) }, cors);
}

async function handleClaim({ request, env, cors, user }: Ctx): Promise<Response> {
  const body = await parseBody(request, cors, claimSchema);
  if (!body.ok) return body.response;
  return json(200, { claimed: await claimOrders(env.DB, user!.id, body.data.orderIds) }, cors);
}

async function handleCancel({ request, env, cors, user, params }: Ctx): Promise<Response> {
  const body = await parseBody(request, cors, emptySchema);
  if (!body.ok) return body.response;
  const result = await cancelOrder(env.DB, user!.id, params.orderId!);
  if (result === "not_found") return error(404, "not_found", "Order not found", cors);
  if (result === "too_late") return error(409, "too_late", "This order can no longer be cancelled", cors);
  return json(200, { ok: true }, cors);
}

function badBody(status: 400 | 413, cors: Record<string, string>): Response {
  return status === 413
    ? error(413, "payload_too_large", "Request is too large", cors)
    : error(400, "bad_json", "Body must be valid JSON", cors);
}
