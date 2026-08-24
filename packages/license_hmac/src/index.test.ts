import { describe, expect, it } from "vitest";
import { issueLicense, verifyLicense, type LicensePayload } from "./index";

const SECRET = "unit-test-secret-do-not-ship";

const perpetual: LicensePayload = { v: 1, p: "clipgrab", e: null, u: "zee" };
const timed: LicensePayload = {
  v: 1,
  p: "transcribeforge",
  e: new Date(Date.now() + 86400_000).toISOString(),
};
const expired: LicensePayload = {
  v: 1,
  p: "transcribeforge",
  e: new Date(Date.now() - 86400_000).toISOString(),
};

describe("license round-trip", () => {
  it("issues and verifies a perpetual license", async () => {
    const key = await issueLicense(perpetual, SECRET);
    expect(key).toMatch(/^FORGE-1-[A-Za-z0-9_-]+-[A-Za-z0-9_-]+$/);
    const res = await verifyLicense(key, SECRET);
    expect(res).toEqual({ ok: true, payload: perpetual });
  });

  it("accepts a valid timed license and rejects an expired one", async () => {
    const okRes = await verifyLicense(await issueLicense(timed, SECRET), SECRET);
    expect(okRes.ok).toBe(true);

    const bad = await verifyLicense(await issueLicense(expired, SECRET), SECRET);
    expect(bad).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects tampered payloads and wrong secrets", async () => {
    const key = await issueLicense(perpetual, SECRET);
    const [head, ver, body, sig] = key.split("-");

    // flip a char inside the payload body -> signature mismatch
    const tamperedBody = (body[0] === "A" ? "B" : "A") + body.slice(1);
    const tampered = `${head}-${ver}-${tamperedBody}-${sig}`;
    expect((await verifyLicense(tampered, SECRET)).reason).toBe("bad_signature");

    // right key, wrong secret
    expect((await verifyLicense(key, "other-secret")).reason).toBe("bad_signature");

    // truncated / garbage keys
    expect((await verifyLicense("FORGE-1-abc", SECRET)).reason).toBe("malformed");
    expect((await verifyLicense("HELLO-1-x-y", SECRET)).reason).toBe("malformed");
  });

  it("b64url round-trips unicode payloads", async () => {
    const payload: LicensePayload = { v: 1, p: "clipgrab", e: null, u: "josé@chr-z.dev ✓" };
    const res = await verifyLicense(await issueLicense(payload, SECRET), SECRET);
    expect(res).toEqual({ ok: true, payload });
  });
});
