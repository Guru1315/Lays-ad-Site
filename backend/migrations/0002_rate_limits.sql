-- Exact per-client write limits. Cloudflare's Rate Limiting binding is approximate and per-location,
-- so the Worker also counts writes here. `bucket` is an HMAC of route + client IP (the raw IP is
-- never stored), and rows older than an hour are pruned by the Worker.
CREATE TABLE rate_limits (
  bucket        TEXT NOT NULL,
  window_start  INTEGER NOT NULL,
  hits          INTEGER NOT NULL DEFAULT 1 CHECK (hits >= 1),
  PRIMARY KEY (bucket, window_start)
);

CREATE INDEX idx_rate_limits_window ON rate_limits(window_start);
