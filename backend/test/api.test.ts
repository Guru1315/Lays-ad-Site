import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { decrypt, importKeys, lookupHash } from "../src/crypto";
import { hitRateLimit, priceBox } from "../src/repo";

const SITE = "https://guru-lays-site.vercel.app";
let ipCounter = 0;

/** Each call uses a fresh client IP so the rate limiter doesn't interfere across tests. */
function post(path: string, body: unknown, opts: { origin?: string | null; type?: string; ip?: string; raw?: string } = {}) {
  const headers: Record<string, string> = {
    "Content-Type": opts.type ?? "application/json",
    "CF-Connecting-IP": opts.ip ?? `203.0.113.${++ipCounter}`,
  };
  if (opts.origin !== null) headers.Origin = opts.origin ?? SITE;
  return SELF.fetch(`https://api.example.com${path}`, {
    method: "POST",
    headers,
    body: opts.raw ?? JSON.stringify(body),
  });
}

const count = async (table: "signups" | "orders" | "order_items" | "flavors") =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;

describe("routing and headers", () => {
  it("health check works and sets security headers", async () => {
    const res = await SELF.fetch("https://api.example.com/api/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Strict-Transport-Security")).toContain("max-age=");
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
  });

  it("unknown routes are 404 and wrong methods are 405", async () => {
    expect((await SELF.fetch("https://api.example.com/api/nope")).status).toBe(404);
    expect((await SELF.fetch("https://api.example.com/api/signups")).status).toBe(405);
  });

  it("lists the flavor catalog with server prices", async () => {
    const res = await SELF.fetch("https://api.example.com/api/flavors");
    const body = await res.json<{ flavors: { id: string; priceCents: number }[] }>();
    expect(body.flavors).toHaveLength(9);
    expect(body.flavors[0]).toEqual({ id: "classic", name: "Classic", priceCents: 249 });
  });
});

describe("CORS and CSRF", () => {
  it("preflight from the site is allowed with an exact origin echo", async () => {
    const res = await SELF.fetch("https://api.example.com/api/signups", {
      method: "OPTIONS",
      headers: { Origin: SITE, "Access-Control-Request-Method": "POST" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(SITE);
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  it("preflight from another origin is refused", async () => {
    const res = await SELF.fetch("https://api.example.com/api/signups", {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("rejects writes from a foreign origin or with no origin", async () => {
    const ok = { email: "a@b.co", consent: true };
    expect((await post("/api/signups", ok, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post("/api/signups", ok, { origin: "https://guru-lays-site.vercel.app.evil.example" })).status).toBe(403);
    expect((await post("/api/signups", ok, { origin: null })).status).toBe(403);
  });

  it("rejects form-encoded posts (which skip CORS preflight)", async () => {
    const res = await post("/api/signups", null, { type: "application/x-www-form-urlencoded", raw: "email=a@b.co&consent=true" });
    expect(res.status).toBe(415);
  });
});

describe("input validation", () => {
  it("rejects bad JSON, oversize bodies and unexpected fields", async () => {
    expect((await post("/api/signups", null, { raw: "{not json" })).status).toBe(400);
    expect((await post("/api/signups", { email: "a@b.co", consent: true, pad: "x".repeat(4000) })).status).toBe(413);

    const extra = await post("/api/signups", { email: "a@b.co", consent: true, isAdmin: true });
    expect(extra.status).toBe(422);
  });

  it("requires a valid email and explicit consent", async () => {
    const bad = await post("/api/signups", { email: "not-an-email", consent: true });
    expect(bad.status).toBe(422);
    const body = await bad.json<{ error: { fields: Record<string, string> } }>();
    expect(body.error.fields.email).toBeDefined();

    expect((await post("/api/signups", { email: "a@b.co", consent: false })).status).toBe(422);
    expect((await post("/api/signups", { email: "a@b.co", consent: "yes" })).status).toBe(422);
    expect((await post("/api/signups", { email: `${"a".repeat(250)}@b.co`, consent: true })).status).toBe(422);
  });

  it("does not echo raw input back in errors (no reflected XSS)", async () => {
    const payload = "<script>alert(1)</script>@x.co";
    const res = await post("/api/signups", { email: payload, consent: true });
    expect(await res.text()).not.toContain("<script>");
  });
});

describe("sign-ups", () => {
  it("stores the email encrypted, never in plain text", async () => {
    const before = await count("signups");
    const res = await post("/api/signups", { email: "  Fan@Example.COM ", consent: true });
    expect(res.status).toBe(201);
    expect(await count("signups")).toBe(before + 1);

    const keys = await importKeys(env.EMAIL_ENC_KEY, env.EMAIL_HASH_KEY);
    const hash = await lookupHash(keys, "fan@example.com");
    const row = await env.DB.prepare("SELECT * FROM signups WHERE email_hash = ?").bind(hash).first<Record<string, string>>();
    expect(row).not.toBeNull();
    expect(JSON.stringify(row)).not.toContain("fan@example.com");
    expect(await decrypt(keys, row!.email_ciphertext!, row!.email_iv!)).toBe("fan@example.com");
  });

  it("answers the same for a repeat email and keeps one row (no enumeration)", async () => {
    const first = await post("/api/signups", { email: "repeat@example.com", consent: true });
    const before = await count("signups");
    const second = await post("/api/signups", { email: "REPEAT@example.com", consent: true });
    expect(second.status).toBe(first.status);
    expect(await second.text()).toBe(await first.text());
    expect(await count("signups")).toBe(before);
  });

  it("silently drops honeypot submissions", async () => {
    const before = await count("signups");
    const res = await post("/api/signups", { email: "bot@example.com", consent: true, website: "http://spam" });
    expect(res.status).toBe(201);
    expect(await count("signups")).toBe(before);
  });

  it("treats SQL in the email as plain data", async () => {
    const tables = await count("flavors");
    const res = await post("/api/signups", { email: "x'); DROP TABLE flavors;--@example.com", consent: true });
    expect([201, 422]).toContain(res.status);
    expect(await count("flavors")).toBe(tables);
  });
});

describe("orders", () => {
  it("prices the box on the server and saves order + items atomically", async () => {
    const res = await post("/api/orders", { items: ["classic", "flamin-hot", "classic"] });
    expect(res.status).toBe(201);
    const { order } = await res.json<{ order: { id: string; subtotalCents: number; discountCents: number; totalCents: number } }>();
    expect(order).toMatchObject({ subtotalCents: 747, discountCents: 149, totalCents: 598 });

    const items = await env.DB.prepare("SELECT slot, flavor_id FROM order_items WHERE order_id = ? ORDER BY slot").bind(order.id).all();
    expect(items.results.map((r) => r.flavor_id)).toEqual(["classic", "flamin-hot", "classic"]);
  });

  it("ignores client-supplied prices (strict schema)", async () => {
    const res = await post("/api/orders", { items: ["classic", "classic", "classic"], totalCents: 1 });
    expect(res.status).toBe(422);
  });

  it("rejects the wrong number of bags and unknown or malicious flavor ids", async () => {
    const before = await count("orders");
    expect((await post("/api/orders", { items: ["classic", "classic"] })).status).toBe(422);
    expect((await post("/api/orders", { items: ["classic", "classic", "ghost-pepper"] })).status).toBe(422);
    expect((await post("/api/orders", { items: ["classic", "classic", "' OR 1=1 --"] })).status).toBe(422);
    expect(await count("orders")).toBe(before);
  });

  it("priceBox never returns a negative total", () => {
    const cheap = [{ id: "a", name: "A", priceCents: 10 }];
    expect(priceBox(["a", "a", "a"], cheap)).toMatchObject({ totalCents: 0, discountCents: 30 });
  });
});

describe("rate limiting", () => {
  it("returns 429 after 5 writes per minute from one IP", async () => {
    const ip = "198.51.100.77";
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      statuses.push((await post("/api/signups", { email: `rl${i}@example.com`, consent: true }, { ip })).status);
    }
    expect(statuses.slice(0, 5).every((s) => s === 201)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it("the D1 counter is exact per window and never stores the raw IP", async () => {
    const t = Date.UTC(2030, 0, 1, 0, 0, 5);
    const hits: number[] = [];
    for (let i = 0; i < 6; i++) hits.push(await hitRateLimit(env.DB, "bucket-a", 60, t));
    expect(hits).toEqual([1, 2, 3, 4, 5, 6]);
    expect(await hitRateLimit(env.DB, "bucket-a", 60, t + 60_000)).toBe(1); // new window
    expect(await hitRateLimit(env.DB, "bucket-b", 60, t)).toBe(1); // separate client

    await post("/api/signups", { email: "ipcheck@example.com", consent: true }, { ip: "192.0.2.55" });
    const dump = await env.DB.prepare("SELECT bucket FROM rate_limits").all();
    expect(JSON.stringify(dump.results)).not.toContain("192.0.2.55");
  });
});

describe("configuration", () => {
  it("fails closed when a key is missing or the wrong length", async () => {
    await expect(importKeys(undefined, env.EMAIL_HASH_KEY)).rejects.toThrow("EMAIL_ENC_KEY");
    await expect(importKeys("c2hvcnQ=", env.EMAIL_HASH_KEY)).rejects.toThrow("32 bytes");
  });
});
