import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SoftAuthenticator } from "./softAuthenticator";

const SITE = "https://guru-lays-site.vercel.app";
const RP_ID = "guru-lays-site.vercel.app";
let ipCounter = 0;

type Opts = { cookie?: string; ip?: string; headers?: Record<string, string> };

function call(method: "GET" | "POST", path: string, body?: unknown, o: Opts = {}) {
  const headers: Record<string, string> = {
    Origin: SITE,
    "CF-Connecting-IP": o.ip ?? `198.18.0.${++ipCounter % 250}`,
    ...o.headers,
  };
  if (method === "POST") headers["Content-Type"] = "application/json";
  if (o.cookie) headers.Cookie = o.cookie;
  return SELF.fetch(`https://api.example.com${path}`, {
    method,
    headers,
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
  });
}

/** Returns "name=value" from a Set-Cookie header, as a browser would send it back. */
function cookieFrom(res: Response): string {
  const set = res.headers.get("Set-Cookie") ?? "";
  return set.split(";")[0]!;
}

async function signUp(displayName?: string) {
  const auth = await SoftAuthenticator.create(SITE, RP_ID);
  const opts = await call("POST", "/api/auth/register/options", displayName ? { displayName } : {});
  expect(opts.status).toBe(200);
  const { challengeId, options } = await opts.json<{ challengeId: string; options: { challenge: string; rp: { id: string }; user: { id: string } } }>();
  const res = await call("POST", "/api/auth/register/verify", { challengeId, response: await auth.register(options) });
  expect(res.status).toBe(201);
  return { auth, cookie: cookieFrom(res), res };
}

async function signIn(auth: SoftAuthenticator, tweak: { origin?: string; userHandle?: string } = {}) {
  const opts = await call("POST", "/api/auth/login/options", {});
  const { challengeId, options } = await opts.json<{ challengeId: string; options: { challenge: string } }>();
  const response = await auth.login(options, tweak);
  return { res: await call("POST", "/api/auth/login/verify", { challengeId, response }), challengeId, response };
}

describe("passkey sign-up and sign-in", () => {
  it("creates a profile with a passkey and sets a hardened session cookie", async () => {
    const { cookie, res } = await signUp("Crunchy Kav");
    const set = res.headers.get("Set-Cookie")!;
    expect(set).toMatch(/^__Host-cl_session=[A-Za-z0-9_-]{43};/);
    for (const attr of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]) expect(set).toContain(attr);
    expect(set).not.toContain("Domain=");

    const me = await call("GET", "/api/me", undefined, { cookie });
    expect(me.status).toBe(200);
    const { user } = await me.json<{ user: { id: string; displayName: string } }>();
    expect(user.displayName).toBe("Crunchy Kav");
  });

  it("stores only a hash of the session token and only the passkey's public key", async () => {
    const { cookie } = await signUp();
    const token = cookie.split("=")[1]!;
    const sessions = await env.DB.prepare("SELECT * FROM sessions").all();
    expect(JSON.stringify(sessions.results)).not.toContain(token);
    const cols = await env.DB.prepare("PRAGMA table_info(passkeys)").all<{ name: string }>();
    expect(cols.results.map((c) => c.name)).not.toContain("private_key");
  });

  it("signs back in with the same passkey and advances the signature counter", async () => {
    const { auth } = await signUp("Returner");
    const { res } = await signIn(auth);
    expect(res.status).toBe(200);
    const me = await call("GET", "/api/me", undefined, { cookie: cookieFrom(res) });
    expect((await me.json<{ user: { displayName: string } }>()).user.displayName).toBe("Returner");
    const row = await env.DB.prepare("SELECT counter FROM passkeys WHERE credential_id = ?").bind(auth.id).first<{ counter: number }>();
    expect(row!.counter).toBe(1);
  });

  it("rejects a replayed challenge", async () => {
    const { auth } = await signUp();
    const first = await signIn(auth);
    expect(first.res.status).toBe(200);
    const replay = await call("POST", "/api/auth/login/verify", { challengeId: first.challengeId, response: first.response });
    expect(replay.status).toBe(400);
  });

  it("rejects a passkey response made for another website (phishing)", async () => {
    const { auth } = await signUp();
    const { res } = await signIn(auth, { origin: "https://guru-lays-site.vercel.app.evil.example" });
    expect(res.status).toBe(400);
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("gives the same error for an unknown passkey and for a bad signature", async () => {
    const stranger = await SoftAuthenticator.create(SITE, RP_ID);
    const unknown = await signIn(stranger);
    const { auth } = await signUp();
    const wrongUser = await signIn(auth, { userHandle: "AAAA" });
    expect(unknown.res.status).toBe(400);
    expect(wrongUser.res.status).toBe(400);
    expect((await unknown.res.json<{ error: { message: string } }>()).error.message).toBe(
      (await wrongUser.res.json<{ error: { message: string } }>()).error.message,
    );
  });

  it("validates display names", async () => {
    expect((await call("POST", "/api/auth/register/options", { displayName: "x".repeat(41) })).status).toBe(422);
    expect((await call("POST", "/api/auth/register/options", { displayName: "bad\u0000name" })).status).toBe(422);
    expect((await call("POST", "/api/auth/register/options", { displayName: "ok", admin: true })).status).toBe(422);
  });
});

describe("sessions", () => {
  it("requires a valid session for profile routes", async () => {
    const anon = async (cookie?: string) => (await (await call("GET", "/api/me", undefined, { cookie })).json<{ user: unknown }>()).user;
    expect(await anon()).toBeNull();
    expect(await anon("__Host-cl_session=" + "a".repeat(43))).toBeNull();
    expect(await anon("__Host-cl_session=' OR 1=1 --")).toBeNull();
    expect((await call("GET", "/api/me/orders")).status).toBe(401);
    expect((await call("POST", "/api/me", { displayName: "x" })).status).toBe(401);
  });

  it("signing out ends the session on the server, not just in the browser", async () => {
    const { cookie } = await signUp();
    const out = await call("POST", "/api/auth/logout", {}, { cookie });
    expect(out.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect((await call("GET", "/api/me/orders", undefined, { cookie })).status).toBe(401);
  });

  it("refuses profile changes from another website even with the cookie (CSRF)", async () => {
    const { cookie } = await signUp("Safe");
    const res = await call("POST", "/api/me", { displayName: "Hacked" }, { cookie, headers: { Origin: "https://evil.example" } });
    expect(res.status).toBe(403);
    const me = await call("GET", "/api/me", undefined, { cookie });
    expect((await me.json<{ user: { displayName: string } }>()).user.displayName).toBe("Safe");
  });

  it("updates the display name and can delete the profile", async () => {
    const { cookie } = await signUp("Old");
    const upd = await call("POST", "/api/me", { displayName: "New name" }, { cookie });
    expect((await upd.json<{ user: { displayName: string } }>()).user.displayName).toBe("New name");

    const del = await call("POST", "/api/me/delete", {}, { cookie });
    expect(del.status).toBe(200);
    expect((await call("GET", "/api/me/orders", undefined, { cookie })).status).toBe(401);
  });
});

describe("order tracking", () => {
  const box = { items: ["classic", "barbecue", "flamin-hot"] };

  it("links orders to the signed-in buyer and lists them with items and a timeline", async () => {
    const { cookie } = await signUp();
    const placed = await call("POST", "/api/orders", box, { cookie });
    const { order, tracked } = await placed.json<{ order: { id: string }; tracked: boolean }>();
    expect(tracked).toBe(true);

    const list = await call("GET", "/api/me/orders", undefined, { cookie });
    const { orders } = await list.json<{ orders: { id: string; status: string; totalCents: number; items: { name: string }[]; events: { status: string }[] }[] }>();
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ id: order.id, status: "placed", totalCents: 598 });
    expect(orders[0]!.items.map((i) => i.name)).toEqual(["Classic", "Barbecue", "Flamin' Hot"]);
    expect(orders[0]!.events.map((e) => e.status)).toEqual(["placed"]);
  });

  it("never shows or lets anyone else cancel your order", async () => {
    const alice = await signUp("Alice");
    const bob = await signUp("Bob");
    const placed = await call("POST", "/api/orders", box, { cookie: alice.cookie });
    const { order } = await placed.json<{ order: { id: string } }>();

    const bobsList = await call("GET", "/api/me/orders", undefined, { cookie: bob.cookie });
    expect((await bobsList.json<{ orders: unknown[] }>()).orders).toHaveLength(0);
    expect((await call("POST", `/api/me/orders/${order.id}/cancel`, {}, { cookie: bob.cookie })).status).toBe(404);

    const status = await env.DB.prepare("SELECT status FROM orders WHERE id = ?").bind(order.id).first<{ status: string }>();
    expect(status!.status).toBe("placed");
  });

  it("cancels your own order once, while it's still only placed", async () => {
    const { cookie } = await signUp();
    const { order } = await (await call("POST", "/api/orders", box, { cookie })).json<{ order: { id: string } }>();
    expect((await call("POST", `/api/me/orders/${order.id}/cancel`, {}, { cookie })).status).toBe(200);
    expect((await call("POST", `/api/me/orders/${order.id}/cancel`, {}, { cookie })).status).toBe(409);

    const { orders } = await (await call("GET", "/api/me/orders", undefined, { cookie })).json<{ orders: { status: string; events: { status: string }[] }[] }>();
    expect(orders[0]!.status).toBe("cancelled");
    expect(orders[0]!.events.map((e) => e.status)).toEqual(["placed", "cancelled"]);
  });

  it("lets a buyer claim guest orders from this browser, but not someone else's", async () => {
    const guest = await (await call("POST", "/api/orders", box)).json<{ order: { id: string }; tracked: boolean }>();
    expect(guest.tracked).toBe(false);

    const owner = await signUp();
    const owned = await (await call("POST", "/api/orders", box, { cookie: owner.cookie })).json<{ order: { id: string } }>();

    const me = await signUp();
    const claim = await call("POST", "/api/me/orders/claim", { orderIds: [guest.order.id, owned.order.id] }, { cookie: me.cookie });
    expect((await claim.json<{ claimed: number }>()).claimed).toBe(1);
    const mine = await (await call("GET", "/api/me/orders", undefined, { cookie: me.cookie })).json<{ orders: { id: string }[] }>();
    expect(mine.orders.map((o) => o.id)).toEqual([guest.order.id]);

    expect((await call("POST", "/api/me/orders/claim", { orderIds: ["not-a-uuid"] }, { cookie: me.cookie })).status).toBe(422);
  });

  it("rejects malformed order ids in the URL", async () => {
    const { cookie } = await signUp();
    expect((await call("POST", "/api/me/orders/1%20OR%201=1/cancel", {}, { cookie })).status).toBe(404);
  });
});

describe("proxy client IP", () => {
  const spam = (ip: string, headers: Record<string, string>) =>
    Promise.all(Array.from({ length: 6 }, (_, i) => call("POST", "/api/signups", { email: `p${i}-${ip}@example.com`, consent: true }, { ip, headers: { ...headers, "X-Client-IP": `10.0.${i}.1` } })));

  it("ignores X-Client-IP without the proxy secret (can't dodge the rate limit)", async () => {
    const res = await spam("203.0.113.200", { "X-Proxy-Auth": "wrong" });
    expect(res.map((r) => r.status)).toContain(429);
  });

  it("uses the real visitor IP when the proxy secret matches", async () => {
    const res = await spam("203.0.113.201", { "X-Proxy-Auth": "test-proxy-secret-0123456789abcdef" });
    expect(res.every((r) => r.status === 201)).toBe(true);
  });
});
