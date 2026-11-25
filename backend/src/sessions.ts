/**
 * Server-side sessions. The browser holds a random 256-bit token in an HttpOnly cookie;
 * the database stores only its SHA-256 hash, so a leaked table can't be used to log in.
 */

export const SESSION_COOKIE = "__Host-cl_session";
const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;

export type SessionUser = { id: string; displayName: string | null; createdAt: string };

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Reads one cookie value from the Cookie header. */
export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/**
 * __Host- prefix: the browser only accepts it with Secure, Path=/ and no Domain,
 * so it can't be set or read by any other host. SameSite=Lax blocks cross-site POSTs.
 */
export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export const clearSessionCookie = () => sessionCookie("", 0);

export async function createSession(db: D1Database, userId: string, now = Date.now()): Promise<string> {
  const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
  await db
    .prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(token), userId, now, now + SESSION_MS)
    .run();
  if (Math.random() < 0.05) {
    await db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now).run();
  }
  return sessionCookie(token, SESSION_DAYS * 24 * 60 * 60);
}

/** Returns the signed-in user, or null for a missing, unknown or expired session. */
export async function getSessionUser(db: D1Database, request: Request, now = Date.now()): Promise<SessionUser | null> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const row = await db
    .prepare(
      "SELECT u.id, u.display_name, u.created_at FROM sessions s JOIN users u ON u.id = s.user_id " +
        "WHERE s.token_hash = ? AND s.expires_at > ?",
    )
    .bind(await sha256Hex(token), now)
    .first<{ id: string; display_name: string | null; created_at: string }>();
  return row ? { id: row.id, displayName: row.display_name, createdAt: row.created_at } : null;
}

export async function deleteSession(db: D1Database, request: Request): Promise<void> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return;
  await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
}
