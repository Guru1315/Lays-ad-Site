// Prints two fresh 32-byte keys (base64) for EMAIL_ENC_KEY and EMAIL_HASH_KEY.
import { randomBytes } from "node:crypto";
for (const name of ["EMAIL_ENC_KEY", "EMAIL_HASH_KEY"]) {
  console.log(`${name}=${randomBytes(32).toString("base64")}`);
}
