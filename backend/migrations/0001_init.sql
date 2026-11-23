-- Crunch Lab schema. Applied only by `wrangler d1 migrations apply`, never by the Worker.
-- D1 enforces foreign keys by default (PRAGMA foreign_keys = ON).

-- Product catalog. The server reads prices from here; it never trusts a price sent by the browser.
CREATE TABLE flavors (
  id           TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 40),
  name         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  price_cents  INTEGER NOT NULL CHECK (price_cents > 0),
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

-- "First dibs" sign-ups. The email is stored encrypted (AES-256-GCM) and looked up by a keyed
-- HMAC-SHA-256 hash, so a leaked database copy does not reveal addresses without the Worker secrets.
CREATE TABLE signups (
  id                TEXT PRIMARY KEY,
  email_hash        TEXT NOT NULL UNIQUE,
  email_ciphertext  TEXT NOT NULL,
  email_iv          TEXT NOT NULL,
  key_version       INTEGER NOT NULL DEFAULT 1,
  consent           INTEGER NOT NULL CHECK (consent = 1),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Build-a-Box orders (demo store: nothing is charged). Totals are computed server-side.
CREATE TABLE orders (
  id              TEXT PRIMARY KEY,
  subtotal_cents  INTEGER NOT NULL CHECK (subtotal_cents >= 0),
  discount_cents  INTEGER NOT NULL CHECK (discount_cents >= 0),
  total_cents     INTEGER NOT NULL CHECK (total_cents >= 0 AND total_cents = subtotal_cents - discount_cents),
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'cancelled', 'fulfilled')),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE order_items (
  order_id          TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  slot              INTEGER NOT NULL CHECK (slot BETWEEN 0 AND 2),
  flavor_id         TEXT NOT NULL REFERENCES flavors(id) ON DELETE RESTRICT,
  unit_price_cents  INTEGER NOT NULL CHECK (unit_price_cents > 0),
  PRIMARY KEY (order_id, slot)
);

CREATE INDEX idx_order_items_flavor ON order_items(flavor_id);

INSERT INTO flavors (id, name, price_cents) VALUES
  ('classic',                 'Classic',                      249),
  ('sour-cream-onion',        'Sour Cream & Onion',           249),
  ('barbecue',                'Barbecue',                     249),
  ('salt-vinegar',            'Salt & Vinegar',               249),
  ('flamin-hot',              'Flamin'' Hot',                 249),
  ('cheddar-sour-cream',      'Cheddar & Sour Cream',         249),
  ('all-dressed',             'All Dressed',                  249),
  ('sweet-southern-heat-bbq', 'Sweet Southern Heat Barbecue', 249),
  ('bacon-grilled-cheese',    'Bacon Grilled Cheese',         249);
