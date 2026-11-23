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
