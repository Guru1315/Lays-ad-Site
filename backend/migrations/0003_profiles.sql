-- Profiles with passkey sign-in, server-side sessions, and order tracking.
-- Passkeys mean no passwords are ever stored: only each authenticator's public key.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  display_name  TEXT CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 40),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- One row per passkey. public_key is the COSE public key (base64url); it is not a secret.
CREATE TABLE passkeys (
  credential_id  TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  webauthn_user  TEXT NOT NULL,
  public_key     TEXT NOT NULL,
  counter        INTEGER NOT NULL DEFAULT 0 CHECK (counter >= 0),
  transports     TEXT,
  device_type    TEXT NOT NULL CHECK (device_type IN ('singleDevice', 'multiDevice')),
  backed_up      INTEGER NOT NULL CHECK (backed_up IN (0, 1)),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at   TEXT
);
CREATE INDEX idx_passkeys_user ON passkeys(user_id);

-- Sessions store only a SHA-256 hash of the cookie token, so a DB leak can't be replayed.
CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

-- Single-use WebAuthn challenges, valid for 5 minutes.
CREATE TABLE auth_challenges (
  id          TEXT PRIMARY KEY,
  challenge   TEXT NOT NULL,
  purpose     TEXT NOT NULL CHECK (purpose IN ('register', 'login')),
  user_id     TEXT,
  user_handle TEXT,
  display_name TEXT,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX idx_auth_challenges_expiry ON auth_challenges(expires_at);

-- Rebuild orders (owner + richer tracking statuses) and order_items together.
-- Dropping "orders" while order_items still referenced it would fire ON DELETE CASCADE
-- and wipe the items, so both tables are copied, the old ones dropped child-first,
-- and the new ones renamed into place (SQLite rewrites the FK reference on rename).
CREATE TABLE orders_new (
  id              TEXT PRIMARY KEY,
  user_id         TEXT REFERENCES users(id) ON DELETE SET NULL,
  subtotal_cents  INTEGER NOT NULL CHECK (subtotal_cents >= 0),
  discount_cents  INTEGER NOT NULL CHECK (discount_cents >= 0),
  total_cents     INTEGER NOT NULL CHECK (total_cents >= 0 AND total_cents = subtotal_cents - discount_cents),
  status          TEXT NOT NULL DEFAULT 'placed'
                  CHECK (status IN ('placed', 'packed', 'shipped', 'delivered', 'cancelled')),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO orders_new (id, user_id, subtotal_cents, discount_cents, total_cents, status, created_at)
SELECT id, NULL, subtotal_cents, discount_cents, total_cents,
       CASE status WHEN 'pending' THEN 'placed' WHEN 'fulfilled' THEN 'delivered' ELSE status END,
       created_at
FROM orders;

CREATE TABLE order_items_new (
  order_id          TEXT NOT NULL REFERENCES orders_new(id) ON DELETE CASCADE,
  slot              INTEGER NOT NULL CHECK (slot BETWEEN 0 AND 2),
  flavor_id         TEXT NOT NULL REFERENCES flavors(id) ON DELETE RESTRICT,
  unit_price_cents  INTEGER NOT NULL CHECK (unit_price_cents > 0),
  PRIMARY KEY (order_id, slot)
);

INSERT INTO order_items_new (order_id, slot, flavor_id, unit_price_cents)
SELECT order_id, slot, flavor_id, unit_price_cents FROM order_items;

DROP TABLE order_items;
DROP TABLE orders;
ALTER TABLE orders_new RENAME TO orders;
ALTER TABLE order_items_new RENAME TO order_items;
CREATE INDEX idx_orders_user ON orders(user_id, created_at);
CREATE INDEX idx_order_items_flavor ON order_items(flavor_id);

-- Status history shown on the tracking timeline.
CREATE TABLE order_events (
  order_id  TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status    TEXT NOT NULL CHECK (status IN ('placed', 'packed', 'shipped', 'delivered', 'cancelled')),
  at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (order_id, status)
);

INSERT INTO order_events (order_id, status, at) SELECT id, 'placed', created_at FROM orders;
INSERT INTO order_events (order_id, status, at) SELECT id, status, created_at FROM orders WHERE status <> 'placed';
