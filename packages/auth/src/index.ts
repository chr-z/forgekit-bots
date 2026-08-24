/**
 * forgekit-auth — verification helpers for Telegram-sourced requests.
 *
 * Two independent mechanisms:
 * 1. `verifyUpdateSignature` — the bot API sets an X-Telegram-Bot-Api-Secret-Token
 *    header on every webhook call when you register the webhook with
 *    secret_token=<random>. Constant-time compare against our secret.
 * 2. `verifyLoginWidget` — HMAC-SHA256 per Telegram Login Widget docs:
 *    key = SHA256(bot token), message = "\n"-joined data-check-string.
 *
 * Both are pure WebCrypto — no Node APIs, works on Workers.
 */

const encoder = new TextEncoder();

/** Hex-encode without leaking through timing side channels. */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Verify the webhook secret header set by the Telegram Bot API. */
export function verifyUpdateSignature(header: string | null, secret: string): boolean {
  if (!header || !secret) return false;
  return safeEqualHex(header, secret);
}

async function hmacSha256(keyBytes: Uint8Array, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes as unknown as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return new Uint8Array(sig);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Verify Telegram Login Widget / WebApp initData-style check strings.
 * `fields` must exclude the `hash` field; order is preserved as received.
 */
export async function verifyCheckStringHash(
  fields: Record<string, string>,
  hashHex: string,
  botToken: string,
): Promise<boolean> {
  const dataCheckString = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const keyMaterial = await crypto.subtle.digest("SHA-256", encoder.encode(botToken));
  const expected = await hmacSha256(new Uint8Array(keyMaterial), dataCheckString);
  return safeEqualHex(toHex(expected), hashHex.toLowerCase());
}

export interface LoginWidgetUser {
  id: number;
  first_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
}

/** Full Login Widget verification: parse, verify, and age-check in one call. */
export async function verifyLoginWidget(
  params: URLSearchParams,
  botToken: string,
  maxAgeSeconds = 86400,
): Promise<LoginWidgetUser | null> {
  const hash = params.get("hash");
  if (!hash) return null;
  const fields: Record<string, string> = {};
  for (const [k, v] of params.entries()) {
    if (k !== "hash") fields[k] = v;
  }
  const ok = await verifyCheckStringHash(fields, hash, botToken);
  if (!ok) return null;

  const userRaw = fields["user"];
  const authDate = Number(fields["auth_date"] ?? 0);
  if (!authDate) return null;
  if (Math.floor(Date.now() / 1000) - authDate > maxAgeSeconds) return null;

  // Two payload shapes exist in the wild:
  // - WebApp initData: `user` field with JSON body
  // - Login Widget redirect: flat id/first_name/username/photo_url fields
  try {
    if (userRaw) {
      return { ...(JSON.parse(userRaw) as Omit<LoginWidgetUser, "auth_date">), authDate };
    }
    const id = Number(fields["id"]);
    if (!id) return null;
    return {
      id,
      first_name: fields["first_name"],
      username: fields["username"],
      photo_url: fields["photo_url"],
      authDate,
    };
  } catch {
    return null;
  }
}
