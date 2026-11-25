/**
 * Data access. Every statement is a fixed SQL string with `?` placeholders and values passed
 * through `.bind()`, so user input is never concatenated into SQL. The Worker never runs DDL
 * (schema lives in migrations/, applied by the owner with wrangler). Writes it does make:
 * - INSERT sign-ups, orders, users, passkeys, sessions, challenges
 * - UPDATE only: an order's owner/status (scoped by user_id), a passkey's counter, a user's
 *   display name, and the rate_limits counters
 * - DELETE only: used challenges, a user's own session on sign-out, expired rows
 */

export type Flavor = { id: string; name: string; priceCents: number };

export const BOX_DISCOUNT_CENTS = 149;

const SQL = {
  activeFlavors: "SELECT id, name, price_cents FROM flavors WHERE active = 1 ORDER BY rowid",
  insertSignup:
    "INSERT INTO signups (id, email_hash, email_ciphertext, email_iv, key_version, consent) " +
    "VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT(email_hash) DO NOTHING",
  insertOrder: "INSERT INTO orders (id, user_id, subtotal_cents, discount_cents, total_cents) VALUES (?, ?, ?, ?, ?)",
  insertOrderEvent: "INSERT INTO order_events (order_id, status) VALUES (?, 'placed')",
  insertOrderItem: "INSERT INTO order_items (order_id, slot, flavor_id, unit_price_cents) VALUES (?, ?, ?, ?)",
  hitRateLimit:
    "INSERT INTO rate_limits (bucket, window_start, hits) VALUES (?, ?, 1) " +
    "ON CONFLICT(bucket, window_start) DO UPDATE SET hits = hits + 1 RETURNING hits",
  pruneRateLimits: "DELETE FROM rate_limits WHERE window_start < ?",
} as const;

/**
 * Counts one write for `bucket` in the current fixed window and returns the new total.
 * D1 has a single primary, so this count is exact (unlike the per-location binding).
 * The only UPDATE/DELETE the Worker runs, and only on this bookkeeping table.
 */
export async function hitRateLimit(db: D1Database, bucket: string, windowSeconds: number, nowMs = Date.now()): Promise<number> {
  const windowStart = Math.floor(nowMs / 1000 / windowSeconds) * windowSeconds;
  const row = await db.prepare(SQL.hitRateLimit).bind(bucket, windowStart).first<{ hits: number }>();
  if (Math.random() < 0.02) {
    await db.prepare(SQL.pruneRateLimits).bind(windowStart - 3600).run();
  }
  return row?.hits ?? 1;
}

export async function listActiveFlavors(db: D1Database): Promise<Flavor[]> {
  const { results } = await db
    .prepare(SQL.activeFlavors)
    .all<{ id: string; name: string; price_cents: number }>();
  return results.map((r) => ({ id: r.id, name: r.name, priceCents: r.price_cents }));
}

export async function insertSignup(
  db: D1Database,
  row: { emailHash: string; ciphertext: string; iv: string; keyVersion: number },
): Promise<void> {
  await db
    .prepare(SQL.insertSignup)
    .bind(crypto.randomUUID(), row.emailHash, row.ciphertext, row.iv, row.keyVersion)
    .run();
}

export type PricedOrder = {
  id: string;
  items: { flavorId: string; unitPriceCents: number }[];
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
};

/** Prices a box from the catalog. Returns null if any flavor is unknown or inactive. */
export function priceBox(flavorIds: string[], catalog: Flavor[]): Omit<PricedOrder, "id"> | null {
  const byId = new Map(catalog.map((f) => [f.id, f]));
  const items: PricedOrder["items"] = [];
  for (const id of flavorIds) {
    const f = byId.get(id);
    if (!f) return null;
    items.push({ flavorId: f.id, unitPriceCents: f.priceCents });
  }
  const subtotalCents = items.reduce((n, i) => n + i.unitPriceCents, 0);
  const discountCents = Math.min(BOX_DISCOUNT_CENTS, subtotalCents);
  return { items, subtotalCents, discountCents, totalCents: subtotalCents - discountCents };
}

/** Writes the order, its items and its first tracking event in one atomic batch. */
export async function insertOrder(
  db: D1Database,
  order: Omit<PricedOrder, "id">,
  userId: string | null = null,
): Promise<PricedOrder> {
  const id = crypto.randomUUID();
  await db.batch([
    db.prepare(SQL.insertOrder).bind(id, userId, order.subtotalCents, order.discountCents, order.totalCents),
    db.prepare(SQL.insertOrderEvent).bind(id),
    ...order.items.map((item, slot) =>
      db.prepare(SQL.insertOrderItem).bind(id, slot, item.flavorId, item.unitPriceCents),
    ),
  ]);
  return { id, ...order };
}
