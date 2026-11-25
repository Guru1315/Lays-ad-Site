// Owner tool: move an order along its tracking timeline.
//   npm run order:status -- <order-id> <packed|shipped|delivered|cancelled> [--local]
// Both arguments are strictly validated before they go into SQL, and it runs with your own
// wrangler login, so it is never exposed to site visitors.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const [id, status, flag] = process.argv.slice(2);
const STATUSES = ["placed", "packed", "shipped", "delivered", "cancelled"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

if (!UUID.test(id ?? "") || !STATUSES.includes(status ?? "")) {
  console.error("Usage: npm run order:status -- <order-id> <packed|shipped|delivered|cancelled> [--local]");
  process.exit(1);
}

// Values are validated against a strict UUID pattern and a fixed list above, so inlining is safe here.
const sql =
  `UPDATE orders SET status = '${status}' WHERE id = '${id}'; ` +
  `INSERT OR IGNORE INTO order_events (order_id, status) SELECT id, '${status}' FROM orders WHERE id = '${id}' AND status = '${status}';`;

// Run wrangler's own JS entry with node directly: no shell, so the SQL reaches it as one argument.
const wrangler = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
execFileSync(
  process.execPath,
  [wrangler, "d1", "execute", "crunch-lab", flag === "--local" ? "--local" : "--remote", "--command", sql],
  { stdio: "inherit" },
);
