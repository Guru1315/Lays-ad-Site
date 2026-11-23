import { ConfigError, encrypt, importKeys, KEY_VERSION, lookupHash } from "./crypto";
import type { Env } from "./env";
import { corsHeaders, error, json, parseAllowedOrigins, readJson } from "./http";
import { insertOrder, insertSignup, listActiveFlavors, priceBox } from "./repo";
import { fieldErrors, MAX_BODY_BYTES, orderSchema, signupSchema } from "./validation";

type Ctx = { request: Request; env: Env; cors: Record<string, string> };
type Handler = (ctx: Ctx) => Promise<Response>;

const routes: Record<string, { method: "GET" | "POST"; handler: Handler }> = {
  "/api/health": { method: "GET", handler: async ({ cors }) => json(200, { ok: true }, cors) },
  "/api/flavors": { method: "GET", handler: handleFlavors },
  "/api/signups": { method: "POST", handler: handleSignup },
  "/api/orders": { method: "POST", handler: handleOrder },
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const allowed = parseAllowedOrigins(env.ALLOWED_ORIGINS);
    const cors = corsHeaders(origin, allowed);
    const route = routes[url.pathname];

    if (!route) return error(404, "not_found", "Not found", cors);

    if (request.method === "OPTIONS") {
      if (!origin || !allowed.has(origin)) return error(403, "origin_not_allowed", "Origin not allowed", cors);
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method !== route.method) {
      return error(405, "method_not_allowed", "Method not allowed", { ...cors, Allow: `${route.method}, OPTIONS` });
    }

    if (route.method === "POST") {
      // Writes are only accepted from the site itself. Browsers always send Origin on POST,
      // so a missing or foreign Origin means another site or a script (CSRF / spam).
      if (!origin || !allowed.has(origin)) return error(403, "origin_not_allowed", "Origin not allowed", cors);

      // Requiring application/json forces a CORS preflight, so plain HTML forms on other sites can't post here.
      const type = request.headers.get("Content-Type") ?? "";
      if (!/^application\/json(\s*;|$)/i.test(type)) {
        return error(415, "unsupported_media_type", "Send JSON", cors);
      }

      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
      const { success } = await env.WRITE_LIMITER.limit({ key: `${url.pathname}:${ip}` });
      if (!success) {
        return error(429, "rate_limited", "Too many requests. Try again in a minute.", { ...cors, "Retry-After": "60" });
      }
    }

    try {
      return await route.handler({ request, env, cors });
    } catch (err) {
      // Log the detail server-side only; the client gets a generic message.
      const requestId = crypto.randomUUID();
      console.error(JSON.stringify({ requestId, path: url.pathname, error: String(err) }));
      if (err instanceof ConfigError) return error(500, "server_misconfigured", "Server is not configured", cors);
      return error(500, "internal_error", "Something went wrong", { ...cors, "X-Request-Id": requestId });
    }
  },
} satisfies ExportedHandler<Env>;

async function handleFlavors({ env, cors }: Ctx): Promise<Response> {
  const flavors = await listActiveFlavors(env.DB);
  return json(200, { flavors }, { ...cors, "Cache-Control": "public, max-age=300" });
}

async function handleSignup({ request, env, cors }: Ctx): Promise<Response> {
  const body = await readJson(request, MAX_BODY_BYTES);
  if (!body.ok) return badBody(body.status, cors);

  const parsed = signupSchema.safeParse(body.value);
  if (!parsed.success) return error(422, "invalid_input", "Check the form", cors, fieldErrors(parsed.error));

  // Bots fill the hidden field; answer as if it worked but store nothing.
  if (parsed.data.website) return json(201, { ok: true }, cors);

  const keys = await importKeys(env.EMAIL_ENC_KEY, env.EMAIL_HASH_KEY);
  const emailHash = await lookupHash(keys, parsed.data.email);
  const { ciphertext, iv } = await encrypt(keys, parsed.data.email);
  await insertSignup(env.DB, { emailHash, ciphertext, iv, keyVersion: KEY_VERSION });

  // Same answer whether the email was new or already listed, so the API can't be used to test who signed up.
  return json(201, { ok: true }, cors);
}

async function handleOrder({ request, env, cors }: Ctx): Promise<Response> {
  const body = await readJson(request, MAX_BODY_BYTES);
  if (!body.ok) return badBody(body.status, cors);

  const parsed = orderSchema.safeParse(body.value);
  if (!parsed.success) return error(422, "invalid_input", "Check your box", cors, fieldErrors(parsed.error));

  const priced = priceBox(parsed.data.items, await listActiveFlavors(env.DB));
  if (!priced) return error(422, "invalid_input", "Check your box", cors, { items: "Unknown flavor" });

  const order = await insertOrder(env.DB, priced);
  return json(201, { order }, cors);
}

function badBody(status: 400 | 413, cors: Record<string, string>): Response {
  return status === 413
    ? error(413, "payload_too_large", "Request is too large", cors)
    : error(400, "bad_json", "Body must be valid JSON", cors);
}
