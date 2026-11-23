/**
 * Drop-in client for the Next.js site (copy to src/lib/crunchLabApi.ts).
 *
 * Set NEXT_PUBLIC_API_URL in Vercel to the Worker URL, e.g. https://crunch-lab-api.<you>.workers.dev
 * It is a public URL, not a secret: the Worker protects itself with the origin allowlist, input
 * validation and rate limiting. Never put EMAIL_ENC_KEY / EMAIL_HASH_KEY in the frontend.
 */

const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/+$/, "");

export type ApiError = { code: string; message: string; fields?: Record<string, string> };
export type Result<T> = { ok: true; data: T } | { ok: false; error: ApiError };

export type Order = {
  id: string;
  items: { flavorId: string; unitPriceCents: number }[];
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
};

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<Result<T>> {
  if (!API_URL) return { ok: false, error: { code: "not_configured", message: "The store is offline right now." } };
  try {
    const res = await fetch(`${API_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      // No cookies are used, so none are sent.
      credentials: "omit",
      signal,
    });
    const data = (await res.json().catch(() => null)) as { error?: ApiError } | null;
    if (!res.ok) {
      return { ok: false, error: data?.error ?? { code: "http_error", message: "Something went wrong. Try again." } };
    }
    return { ok: true, data: data as T };
  } catch {
    return { ok: false, error: { code: "network", message: "Can't reach the server. Check your connection." } };
  }
}

/** Join "first dibs". `website` is the hidden honeypot input's value (leave it empty for real users). */
export function joinList(email: string, consent: boolean, website = "", signal?: AbortSignal) {
  return post<{ ok: true }>("/api/signups", { email, consent, website }, signal);
}

/** Place a Build-a-Box order. The server prices it; never send prices from the browser. */
export function placeBoxOrder(flavorIds: string[], signal?: AbortSignal) {
  return post<{ order: Order }>("/api/orders", { items: flavorIds }, signal);
}
