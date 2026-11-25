/**
 * Client for the Crunch Lab API. Calls go to /api/* on this same site; src/proxy.ts forwards
 * them to the Cloudflare Worker. Nothing secret lives here: the Worker protects itself with an
 * origin check, input validation, rate limiting and an HttpOnly session cookie.
 */
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";

export type ApiError = { code: string; message: string; fields?: Record<string, string> };
export type Result<T> = { ok: true; data: T } | { ok: false; error: ApiError };

export type Order = {
  id: string;
  items: { flavorId: string; unitPriceCents: number }[];
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
};

export type User = { id: string; displayName: string | null; createdAt: string };

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

async function request<T>(method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal): Promise<Result<T>> {
  try {
    const res = await fetch(path, {
      method,
      headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });
    const data = (await res.json().catch(() => null)) as ({ error?: ApiError } & T) | null;
    if (!res.ok) {
      return { ok: false, error: data?.error ?? { code: "http_error", message: "Something went wrong. Try again." } };
    }
    return { ok: true, data: data as T };
  } catch (err) {
    if ((err as Error)?.name === "AbortError") return { ok: false, error: { code: "aborted", message: "" } };
    return { ok: false, error: { code: "network", message: "Can't reach the server. Check your connection." } };
  }
}

/** Join "first dibs". `website` is the hidden honeypot input's value (leave it empty for real users). */
export function joinList(email: string, consent: boolean, website = "", signal?: AbortSignal) {
  return request<{ ok: true }>("POST", "/api/signups", { email, consent, website }, signal);
}

/** Place a Build-a-Box order. The server prices it; never send prices from the browser. */
export function placeBoxOrder(flavorIds: string[], signal?: AbortSignal) {
  return request<{ order: Order; tracked: boolean }>("POST", "/api/orders", { items: flavorIds }, signal);
}

// ---------- guest orders (placed before signing in, claimable later) ----------

const GUEST_KEY = "crunch-lab:guest-orders";

export function rememberGuestOrder(id: string) {
  try {
    const ids = JSON.parse(localStorage.getItem(GUEST_KEY) ?? "[]") as string[];
    localStorage.setItem(GUEST_KEY, JSON.stringify([id, ...ids.filter((x) => x !== id)].slice(0, 20)));
  } catch {
    /* storage unavailable: the order just won't be claimable */
  }
}

/** Moves orders placed on this device as a guest into the signed-in profile. */
export async function claimGuestOrders(): Promise<number> {
  let ids: unknown = [];
  try {
    ids = JSON.parse(localStorage.getItem(GUEST_KEY) ?? "[]");
  } catch {
    return 0;
  }
  if (!Array.isArray(ids) || ids.length === 0) return 0;
  const res = await request<{ claimed: number }>("POST", "/api/me/orders/claim", { orderIds: ids.slice(0, 20) });
  if (!res.ok) return 0;
  try {
    localStorage.removeItem(GUEST_KEY);
  } catch {
    /* ignore */
  }
  return res.data.claimed;
}

// ---------- profile ----------

export const passkeysSupported = () => typeof window !== "undefined" && browserSupportsWebAuthn();

/** Turns browser WebAuthn errors into plain language. */
function passkeyMessage(err: unknown): ApiError {
  const name = (err as Error)?.name;
  if (name === "NotAllowedError" || name === "AbortError") {
    return { code: "cancelled", message: "The passkey prompt was closed. Try again when you're ready." };
  }
  if (name === "InvalidStateError") {
    return { code: "exists", message: "This device already has a Crunch Lab passkey. Use “Sign in” instead." };
  }
  if (name === "SecurityError") {
    return { code: "security", message: "Passkeys only work on the Crunch Lab site itself." };
  }
  return { code: "passkey_error", message: "Your browser couldn't use a passkey. Try another browser or device." };
}

export async function createProfile(displayName: string): Promise<Result<{ ok: true }>> {
  const opts = await request<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }>(
    "POST",
    "/api/auth/register/options",
    displayName.trim() ? { displayName: displayName.trim() } : {},
  );
  if (!opts.ok) return opts;
  let response;
  try {
    response = await startRegistration({ optionsJSON: opts.data.options });
  } catch (err) {
    return { ok: false, error: passkeyMessage(err) };
  }
  return request("POST", "/api/auth/register/verify", { challengeId: opts.data.challengeId, response });
}

export async function signInWithPasskey(): Promise<Result<{ ok: true }>> {
  const opts = await request<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }>(
    "POST",
    "/api/auth/login/options",
    {},
  );
  if (!opts.ok) return opts;
  let response;
  try {
    response = await startAuthentication({ optionsJSON: opts.data.options });
  } catch (err) {
    return { ok: false, error: passkeyMessage(err) };
  }
  return request("POST", "/api/auth/login/verify", { challengeId: opts.data.challengeId, response });
}

/** The signed-in user, or null when signed out. */
export const getMe = (signal?: AbortSignal) => request<{ user: User | null }>("GET", "/api/me", undefined, signal);
export const signOut = () => request<{ ok: true }>("POST", "/api/auth/logout", {});
export const updateName = (displayName: string | null) => request<{ user: User }>("POST", "/api/me", { displayName });
export const deleteProfile = () => request<{ ok: true }>("POST", "/api/me/delete", {});
export const getMyOrders = (signal?: AbortSignal) =>
  request<{ orders: TrackedOrder[] }>("GET", "/api/me/orders", undefined, signal);
export const cancelMyOrder = (id: string) =>
  request<{ ok: true }>("POST", `/api/me/orders/${encodeURIComponent(id)}/cancel`, {});
