/**
 * Data access. Every statement is a fixed SQL string with `?` placeholders and values passed
 * through `.bind()`, so user input is never concatenated into SQL. The Worker only runs
 * SELECT and INSERT here: no UPDATE/DELETE of customer data and no schema changes (DDL lives in
 * migrations/, applied by the owner with wrangler).
 */

export type Flavor = { id: string; name: string; priceCents: number };

export const BOX_DISCOUNT_CENTS = 149;

const SQL = {
  activeFlavors: "SELECT id, name, price_cents FROM flavors WHERE active = 1 ORDER BY rowid",
  insertSignup:
    "INSERT INTO signups (id, email_hash, email_ciphertext, email_iv, key_version, consent) " +
    "VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT(email_hash) DO NOTHING",
  insertOrder: "INSERT INTO orders (id, subtotal_cents, discount_cents, total_cents) VALUES (?, ?, ?, ?)",
  insertOrderItem: "INSERT INTO order_items (order_id, slot, flavor_id, unit_price_cents) VALUES (?, ?, ?, ?)",
} as const;

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

/** Writes the order and its items in one atomic batch (all rows or none). */
export async function insertOrder(db: D1Database, order: Omit<PricedOrder, "id">): Promise<PricedOrder> {
  const id = crypto.randomUUID();
  await db.batch([
    db.prepare(SQL.insertOrder).bind(id, order.subtotalCents, order.discountCents, order.totalCents),
    ...order.items.map((item, slot) =>
      db.prepare(SQL.insertOrderItem).bind(id, slot, item.flavorId, item.unitPriceCents),
    ),
  ]);
  return { id, ...order };
}
