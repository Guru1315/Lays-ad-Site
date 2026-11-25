/**
 * A minimal software passkey for tests: a real P-256 key pair that produces genuine
 * WebAuthn registration and assertion responses ("none" attestation), so the server's
 * real verification code runs end to end.
 */

const enc = new TextEncoder();

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

// --- tiny CBOR encoder (just what WebAuthn needs) ---
type Cbor = number | string | Uint8Array | Map<number | string, Cbor>;

function head(major: number, n: number): Uint8Array {
  if (n < 24) return new Uint8Array([(major << 5) | n]);
  if (n < 256) return new Uint8Array([(major << 5) | 24, n]);
  if (n < 65536) return new Uint8Array([(major << 5) | 25, n >> 8, n & 255]);
  return new Uint8Array([(major << 5) | 26, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
}

function cbor(v: Cbor): Uint8Array {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") {
    const b = enc.encode(v);
    return concat(head(3, b.length), b);
  }
  if (v instanceof Uint8Array) return concat(head(2, v.length), v);
  const parts: Uint8Array[] = [head(5, v.size)];
  for (const [k, val] of v) parts.push(cbor(k), cbor(val));
  return concat(...parts);
}

/** WebCrypto signs ES256 as raw r||s; WebAuthn wants an ASN.1 DER SEQUENCE of two INTEGERs. */
function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v: Uint8Array = b.slice(i);
    if (v[0]! & 0x80) v = concat(new Uint8Array([0]), v);
    return concat(new Uint8Array([0x02, v.length]), v);
  };
  const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return concat(new Uint8Array([0x30, body.length]), body);
}

type CreationOptions = { challenge: string; rp: { id?: string }; user: { id: string } };
type RequestOptions = { challenge: string; rpId?: string };

export class SoftAuthenticator {
  private keys!: CryptoKeyPair;
  readonly credentialId = crypto.getRandomValues(new Uint8Array(16));
  userHandle = "";
  private counter = 0;

  constructor(
    private readonly origin: string,
    private readonly rpId: string,
  ) {}

  static async create(origin: string, rpId: string) {
    const a = new SoftAuthenticator(origin, rpId);
    a.keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    return a;
  }

  get id() {
    return b64url(this.credentialId);
  }

  private async authData(flags: number, attested?: Uint8Array) {
    const count = new Uint8Array([(this.counter >>> 24) & 255, (this.counter >>> 16) & 255, (this.counter >>> 8) & 255, this.counter & 255]);
    return concat(await sha256(enc.encode(this.rpId)), new Uint8Array([flags]), count, attested ?? new Uint8Array());
  }

  private clientData(type: string, challenge: string, origin = this.origin) {
    return enc.encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  /** Answers navigator.credentials.create(). */
  async register(options: CreationOptions, opts: { origin?: string } = {}) {
    this.userHandle = options.user.id;
    const raw = new Uint8Array((await crypto.subtle.exportKey("raw", this.keys.publicKey)) as ArrayBuffer); // 0x04 | x | y
    const cose = cbor(
      new Map<number, Cbor>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, raw.slice(1, 33)],
        [-3, raw.slice(33, 65)],
      ]),
    );
    const attested = concat(
      new Uint8Array(16), // AAGUID
      new Uint8Array([0, this.credentialId.length]),
      this.credentialId,
      cose,
    );
    const authData = await this.authData(0x01 | 0x04 | 0x40, attested); // UP | UV | AT
    const attestationObject = cbor(
      new Map<string, Cbor>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key" as const,
      response: {
        clientDataJSON: b64url(this.clientData("webauthn.create", options.challenge, opts.origin)),
        attestationObject: b64url(attestationObject),
        transports: ["internal"],
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  /** Answers navigator.credentials.get(). */
  async login(options: RequestOptions, opts: { origin?: string; userHandle?: string } = {}) {
    this.counter += 1;
    const authData = await this.authData(0x01 | 0x04); // UP | UV
    const clientDataJSON = this.clientData("webauthn.get", options.challenge, opts.origin);
    const signed = concat(authData, await sha256(clientDataJSON));
    const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.keys.privateKey, signed));
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key" as const,
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(rawToDer(sig)),
        userHandle: opts.userHandle ?? this.userHandle,
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }
}
