import { beforeAll, describe, expect, it } from "vitest";
import { verifyCheckStringHash, verifyLoginWidget, verifyUpdateSignature } from "./index";

const BOT_TOKEN = "123456:ABC-DEF_test_token";

/** Reference HMAC (RFC 4231 style) so tests don't depend on our own impl. */
async function sha256Hex(msg: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacHex(keyBytes: Uint8Array, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes as unknown as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("verifyUpdateSignature", () => {
  it("accepts exact match and rejects anything else", () => {
    expect(verifyUpdateSignature("s3cr3t", "s3cr3t")).toBe(true);
    expect(verifyUpdateSignature("s3cr3t", "s3cr3u")).toBe(false);
    expect(verifyUpdateSignature(null, "s3cr3t")).toBe(false);
    expect(verifyUpdateSignature("s3cr3t", "")).toBe(false);
  });
});

describe("login widget verification", () => {
  let keyHash: string;
  let authDate: number;

  beforeAll(async () => {
    keyHash = await sha256Hex(BOT_TOKEN);
    authDate = Math.floor(Date.now() / 1000) - 60;
  });

  it("accepts a correctly signed check string and parses the user", async () => {
    const fields: Record<string, string> = {
      auth_date: String(authDate),
      first_name: "Zee",
      id: "42",
      username: "zee_dev",
    };
    const dcs = Object.entries(fields).map(([k, v]) => `${k}=${v}`).join("\n");
    const hash = await hmacHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(BOT_TOKEN))), dcs);

    const params = new URLSearchParams({ ...fields, hash });
    const user = await verifyLoginWidget(params, BOT_TOKEN);
    expect(user).toMatchObject({ id: 42, username: "zee_dev" });

    // sanity: independent recompute matches
    expect(hash).toBe(await hmacHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(BOT_TOKEN))), dcs));
  });

  it("rejects a tampered payload", async () => {
    const fields: Record<string, string> = { auth_date: String(authDate), id: "42" };
    const dcs = "auth_date=" + authDate + "\nid=42";
    const hash = await hmacHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(BOT_TOKEN))), dcs);

    const params = new URLSearchParams({ ...fields, id: "43", hash });
    expect(await verifyLoginWidget(params, BOT_TOKEN)).toBeNull();
  });

  it("rejects stale auth_date", async () => {
    const old = Math.floor(Date.now() / 1000) - 7 * 86400;
    const fields: Record<string, string> = { auth_date: String(old), id: "1" };
    const dcs = `auth_date=${old}\nid=1`;
    const hash = await hmacHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(BOT_TOKEN))), dcs);
    const params = new URLSearchParams({ ...fields, hash });
    expect(await verifyLoginWidget(params, BOT_TOKEN)).toBeNull();
  });

  it("verifyCheckStringHash is case-insensitive on the provided hex", async () => {
    const dcs = "id=9";
    const hash = await hmacHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(BOT_TOKEN))), dcs);
    expect(await verifyCheckStringHash({ id: "9" }, hash.toUpperCase(), BOT_TOKEN)).toBe(true);
    expect(await verifyCheckStringHash({ id: "9" }, "00".repeat(32), BOT_TOKEN)).toBe(false);
  });
});
