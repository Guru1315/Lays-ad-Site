/**
 * Profile data. Every query here is scoped by the signed-in user's id (taken from the
 * session, never from the request body), which is the Worker's equivalent of row-level security.
 */

export type OrderStatus = "placed" | "packed" | "shipped" | "delivered" | "cancelled";

export type TrackedOrder = {
  id: string;
  status: OrderStatus;
  createdAt: string;
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  items: { slot: number; flavorId: string; name: string; unitPriceCents: number }[];
  events: { status: OrderStatus; at: string }[];
};

type OrderRow = {
  id: string;
  status: OrderStatus;
  created_at: string;
  subtotal_cents: number;
  discount_cents: number;
  total_cents: number;
  items: string;
  events: string;
};

const LIST_ORDERS = `
  SELECT o.id, o.status, o.created_at, o.subtotal_cents, o.discount_cents, o.total_cents,
    (SELECT json_group_array(json_object('slot', i.slot, 'flavorId', i.flavor_id, 'name', f.name, 'unitPriceCents', i.unit_price_cents))
       FROM (SELECT * FROM order_items WHERE order_id = o.id ORDER BY slot) i JOIN flavors f ON f.id = i.flavor_id) AS items,
    (SELECT json_group_array(json_object('status', e.status, 'at', e.at))
       FROM (SELECT * FROM order_events WHERE order_id = o.id ORDER BY at) e) AS events
  FROM orders o
  WHERE o.user_id = ?
  ORDER BY o.created_at DESC
  LIMIT 50`;

export async function listOrders(db: D1Database, userId: string): Promise<TrackedOrder[]> {
  const { results } = await db.prepare(LIST_ORDERS).bind(userId).all<OrderRow>();
  return results.map((r) => ({
    id: r.id,
    status: r.status,
    createdAt: r.created_at,
    subtotalCents: r.subtotal_cents,
    discountCents: r.discount_cents,
    totalCents: r.total_cents,
    items: JSON.parse(r.items),
    events: JSON.parse(r.events),
  }));
}

export async function updateDisplayName(db: D1Database, userId: string, displayName: string | null): Promise<void> {
  await db.prepare("UPDATE users SET display_name = ? WHERE id = ?").bind(displayName, userId).run();
}

/**
 * Cancels the user's own order while it's still only "placed".
 * Returns "ok", "not_found" (no such order for this user) or "too_late".
 */
export async function cancelOrder(db: D1Database, userId: string, orderId: string): Promise<"ok" | "not_found" | "too_late"> {
  const [update] = await db.batch([
    db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ? AND user_id = ? AND status = 'placed'").bind(orderId, userId),
    db
      .prepare(
        "INSERT OR IGNORE INTO order_events (order_id, status) " +
          "SELECT id, 'cancelled' FROM orders WHERE id = ? AND user_id = ? AND status = 'cancelled'",
      )
      .bind(orderId, userId),
  ]);
  if (update!.meta.changes > 0) return "ok";
  const exists = await db.prepare("SELECT 1 FROM orders WHERE id = ? AND user_id = ?").bind(orderId, userId).first();
  return exists ? "too_late" : "not_found";
}

/**
 * Attaches orders placed on this device before signing in. Order ids are random UUIDs that
 * only the buyer's browser received, and only orders with no owner yet can be claimed.
 */
export async function claimOrders(db: D1Database, userId: string, orderIds: string[]): Promise<number> {
  if (orderIds.length === 0) return 0;
  const placeholders = orderIds.map(() => "?").join(", ");
  const res = await db
    .prepare(`UPDATE orders SET user_id = ? WHERE user_id IS NULL AND id IN (${placeholders})`)
    .bind(userId, ...orderIds)
    .run();
  return res.meta.changes;
}

/** Deletes the user and, via ON DELETE CASCADE / SET NULL, their passkeys and sessions. Orders stay, unowned. */
export async function deleteAccount(db: D1Database, userId: string): Promise<void> {
  await db.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();
}
