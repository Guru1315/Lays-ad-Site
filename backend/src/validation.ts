import { z } from "zod";

/** Largest request body the API will read, in bytes. Both payloads are far smaller. */
export const MAX_BODY_BYTES = 2048;

/** Flavor ids are short lowercase slugs, checked against the database catalog afterwards. */
const flavorId = z.string().regex(/^[a-z0-9-]{1,40}$/, "Unknown flavor");

export const signupSchema = z
  .object({
    email: z
      .string()
      .trim()
      .max(254, "Email is too long")
      .pipe(z.email("Enter a valid email address"))
      .transform((e) => e.toLowerCase()),
    consent: z.literal(true, { error: "Consent is required" }),
    /** Honeypot: hidden in the form, so real people leave it empty. */
    website: z.string().max(200).optional(),
  })
  .strict();

export const orderSchema = z
  .object({
    items: z.array(flavorId).length(3, "A box holds exactly 3 bags"),
  })
  .strict();

/** Larger cap for passkey payloads, which carry signed binary data. */
export const MAX_AUTH_BODY_BYTES = 16 * 1024;

/** 1–40 printable characters; control and invisible formatting characters are rejected. */
const displayName = z
  .string()
  .trim()
  .min(1, "Enter a name")
  .max(40, "Use 40 characters or fewer")
  .refine((s) => !/[\p{Cc}\p{Cf}]/u.test(s), "Use letters, numbers and symbols only");

export const registerOptionsSchema = z.object({ displayName: displayName.optional() }).strict();
export const emptySchema = z.object({}).strict();

/** Shape check only; the cryptographic checks happen in @simplewebauthn/server. */
const b64url = z.string().max(4096).regex(/^[A-Za-z0-9_-]*$/);
export const registerVerifySchema = z
  .object({
    challengeId: z.uuid(),
    response: z
      .object({
        id: b64url,
        rawId: b64url,
        type: z.literal("public-key"),
        response: z.object({ clientDataJSON: b64url, attestationObject: b64url }).loose(),
      })
      .loose(),
  })
  .strict();
export const loginVerifySchema = z
  .object({
    challengeId: z.uuid(),
    response: z
      .object({
        id: b64url,
        rawId: b64url,
        type: z.literal("public-key"),
        response: z
          .object({ clientDataJSON: b64url, authenticatorData: b64url, signature: b64url, userHandle: b64url.optional() })
          .loose(),
      })
      .loose(),
  })
  .strict();

export const profileUpdateSchema = z.object({ displayName: displayName.nullable() }).strict();
export const claimSchema = z.object({ orderIds: z.array(z.uuid()).max(20) }).strict();

export type SignupInput = z.infer<typeof signupSchema>;
export type OrderInput = z.infer<typeof orderSchema>;

/** Turns a Zod error into a short, safe list of field messages (no input values echoed back). */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.length ? issue.path.join(".") : "body";
    out[key] ??= issue.code === "unrecognized_keys" ? "Unexpected field" : issue.message;
  }
  return out;
}
