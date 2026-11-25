/**
 * Passkey (WebAuthn) sign-up and sign-in. The server never sees a password: it stores each
 * passkey's public key and verifies a signature over a single-use random challenge.
 */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import type { Env } from "./env";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export class PasskeyError extends Error {
  constructor(
    public readonly status: 400 | 409,
    message: string,
  ) {
    super(message);
  }
}

export type RelyingParty = { id: string; name: string; origins: string[] };

/** Reads the relying-party settings; refuses to run passkeys if they're missing. */
export function relyingParty(env: Env): RelyingParty | null {
  const origins = (env.RP_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter((s) => /^https?:\/\/[^\s/]+$/.test(s));
  if (!env.RP_ID || origins.length === 0) return null;
  return { id: env.RP_ID, name: env.RP_NAME || "Crunch Lab", origins };
}

async function saveChallenge(
  db: D1Database,
  row: { challenge: string; purpose: "register" | "login"; userHandle?: string; displayName?: string | null },
  now: number,
): Promise<string> {
  const id = crypto.randomUUID();
  await db.batch([
    db.prepare("DELETE FROM auth_challenges WHERE expires_at < ?").bind(now),
    db
      .prepare(
        "INSERT INTO auth_challenges (id, challenge, purpose, user_handle, display_name, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(id, row.challenge, row.purpose, row.userHandle ?? null, row.displayName ?? null, now + CHALLENGE_TTL_MS),
  ]);
  return id;
}

/** Fetches and deletes a challenge in one statement, so it can only ever be used once. */
async function consumeChallenge(db: D1Database, id: string, purpose: "register" | "login", now: number) {
  return db
    .prepare("DELETE FROM auth_challenges WHERE id = ? AND purpose = ? AND expires_at > ? RETURNING challenge, user_handle, display_name")
    .bind(id, purpose, now)
    .first<{ challenge: string; user_handle: string | null; display_name: string | null }>();
}

export async function registrationOptions(db: D1Database, rp: RelyingParty, displayName: string | null, now = Date.now()) {
  const options = await generateRegistrationOptions({
    rpName: rp.name,
    rpID: rp.id,
    userName: displayName ?? "Crunch Lab fan",
    userDisplayName: displayName ?? "Crunch Lab fan",
    userID: crypto.getRandomValues(new Uint8Array(32)),
    attestationType: "none",
    // Discoverable credential, so sign-in needs no username at all.
    authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    timeout: CHALLENGE_TTL_MS,
  });
  const challengeId = await saveChallenge(
    db,
    { challenge: options.challenge, purpose: "register", userHandle: options.user.id, displayName },
    now,
  );
  return { challengeId, options };
}

/** Verifies a new passkey and creates the user. Returns the new user id. */
export async function verifyRegistration(
  db: D1Database,
  rp: RelyingParty,
  challengeId: string,
  response: RegistrationResponseJSON,
  now = Date.now(),
): Promise<string> {
  const row = await consumeChallenge(db, challengeId, "register", now);
  if (!row?.user_handle) throw new PasskeyError(400, "This sign-up request expired. Try again.");

  let result;
  try {
    result = await verifyRegistrationResponse({
      response,
      expectedChallenge: row.challenge,
      expectedOrigin: rp.origins,
      expectedRPID: rp.id,
      requireUserVerification: false,
    });
  } catch (err) {
    console.warn(JSON.stringify({ event: "passkey_register_rejected", reason: String(err) }));
    throw new PasskeyError(400, "We couldn't verify that passkey. Try again.");
  }
  if (!result.verified) throw new PasskeyError(400, "We couldn't verify that passkey. Try again.");

  const { credential, credentialDeviceType, credentialBackedUp } = result.registrationInfo;
  const existing = await db.prepare("SELECT 1 FROM passkeys WHERE credential_id = ?").bind(credential.id).first();
  if (existing) throw new PasskeyError(409, "That passkey is already linked to a profile. Sign in instead.");

  const userId = crypto.randomUUID();
  await db.batch([
    db.prepare("INSERT INTO users (id, display_name) VALUES (?, ?)").bind(userId, row.display_name),
    db
      .prepare(
        "INSERT INTO passkeys (credential_id, user_id, webauthn_user, public_key, counter, transports, device_type, backed_up) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        credential.id,
        userId,
        row.user_handle,
        isoBase64URL.fromBuffer(credential.publicKey),
        credential.counter,
        JSON.stringify(credential.transports ?? []),
        credentialDeviceType,
        credentialBackedUp ? 1 : 0,
      ),
  ]);
  return userId;
}

export async function authenticationOptions(db: D1Database, rp: RelyingParty, now = Date.now()) {
  const options = await generateAuthenticationOptions({
    rpID: rp.id,
    userVerification: "preferred",
    timeout: CHALLENGE_TTL_MS,
  });
  const challengeId = await saveChallenge(db, { challenge: options.challenge, purpose: "login" }, now);
  return { challengeId, options };
}

/** Verifies a passkey sign-in. Returns the user id it belongs to. */
export async function verifyAuthentication(
  db: D1Database,
  rp: RelyingParty,
  challengeId: string,
  response: AuthenticationResponseJSON,
  now = Date.now(),
): Promise<string> {
  const row = await consumeChallenge(db, challengeId, "login", now);
  if (!row) throw new PasskeyError(400, "This sign-in request expired. Try again.");

  const key = await db
    .prepare("SELECT credential_id, user_id, webauthn_user, public_key, counter, transports FROM passkeys WHERE credential_id = ?")
    .bind(response.id)
    .first<{ credential_id: string; user_id: string; webauthn_user: string; public_key: string; counter: number; transports: string | null }>();
  // Same message for "unknown passkey" and "bad signature", so the API doesn't reveal which passkeys exist.
  const fail = () => new PasskeyError(400, "We couldn't sign you in with that passkey.");
  if (!key) throw fail();
  if (response.response.userHandle && response.response.userHandle !== key.webauthn_user) throw fail();

  let result;
  try {
    result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: row.challenge,
      expectedOrigin: rp.origins,
      expectedRPID: rp.id,
      requireUserVerification: false,
      credential: {
        id: key.credential_id,
        publicKey: isoBase64URL.toBuffer(key.public_key),
        counter: key.counter,
        transports: key.transports ? JSON.parse(key.transports) : undefined,
      },
    });
  } catch (err) {
    console.warn(JSON.stringify({ event: "passkey_login_rejected", reason: String(err) }));
    throw fail();
  }
  if (!result.verified) throw fail();

  await db
    .prepare("UPDATE passkeys SET counter = ?, last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE credential_id = ?")
    .bind(result.authenticationInfo.newCounter, key.credential_id)
    .run();
  return key.user_id;
}
