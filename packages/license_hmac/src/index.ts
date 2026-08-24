/**
 * forgekit-license-hmac — offline license keys for the web products.
 *
 * Key format:  FORGE-<version>-<payloadB64url>-<sigB64url>
 *   payload = { v, p (product id), e (expiry ISO or null), u (user note) }
 *   sig     = HMAC-SHA256(secret, version + "." + payloadB64url)
 *
 * The secret NEVER ships in client code — only Workers hold it. The web
 * apps verify via a Worker endpoint (or an embedded public verification
 * table for fully offline Pro flags). Tampering breaks the signature.
 */

const encoder = new TextEncoder();

export interface LicensePayload {
  /** schema version */
  v: 1;
  /** product id, e.g. "clipgrab", "transcribeforge" */
  p: string;
  /** expiry ISO date, or null for perpetual */
  e: string | null;
  /** free-form holder note (email or tg handle), never validated */
  u?: string;
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret) as unknown as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return b64urlEncode(new Uint8Array(sig));
}

export async function issueLicense(
  payload: LicensePayload,
  secret: string,
): Promise<string> {
  if (!secret) throw new Error("license secret is required");
  const body = b64urlEncode(encoder.encode(JSON.stringify(payload)));
  const sig = await hmac(secret, `${payload.v}.${body}`);
  // Separator MUST be "." — base64url's alphabet already contains "-" and "_",
  // so dash-delimited keys are ambiguous to parse.
  return `FORGE.${payload.v}.${body}.${sig}`;
}

export type VerifyResult =
  | { ok: true; payload: LicensePayload }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

export async function verifyLicense(
  key: string,
  secret: string,
  now: Date = new Date(),
): Promise<VerifyResult> {
  // Format: FORGE.<version>.<body>.<sig> — dots are unambiguous because
  // base64url never emits them.
  const parts = key.trim().split(".");
  if (parts.length !== 4 || parts[0] !== "FORGE") return { ok: false, reason: "malformed" };
  const versionRaw = parts[1]!;
  const body = parts[2]!;
  const sig = parts[3]!;
  const version = Number(versionRaw);
  if (!Number.isInteger(version)) return { ok: false, reason: "malformed" };

  const expected = await hmac(secret, `${version}.${body}`);
  // constant-time-ish compare on fixed-size strings
  if (expected.length !== sig.length) return { ok: false, reason: "bad_signature" };
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return { ok: false, reason: "bad_signature" };

  let payload: LicensePayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as LicensePayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (payload.v !== version) return { ok: false, reason: "malformed" };

  if (payload.e && new Date(payload.e).getTime() < now.getTime()) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, payload };
}
