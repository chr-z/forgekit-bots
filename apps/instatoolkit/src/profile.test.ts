import { afterEach, describe, expect, it } from "vitest";
import { extractProfileBlob, fetchProfile, renderReport, toSnapshot, type HydrationUser } from "./profile";

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});

const blob: HydrationUser = {
  data: {
    user: {
      username: "zee.dev",
      full_name: "Christian Eliel",
      biography: "software engineer",
      edge_followed_by: { count: 12345 },
      edge_follow: { count: 432 },
      edge_owner_to_timeline_media: { count: 87 },
      is_private: false,
      is_verified: true,
    },
  },
};

describe("profile parsing", () => {
  it("extracts the hydration blob", () => {
    const html = `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${JSON.stringify(blob)}</script>`;
    expect(toSnapshot(extractProfileBlob(html))).toMatchObject({
      username: "zee.dev",
      followers: 12345,
      isVerified: true,
    });
  });

  it("returns null for private/missing users and broken html", () => {
    expect(toSnapshot(null)).toBeNull();
    expect(toSnapshot({ data: {} })).toBeNull();
    expect(extractProfileBlob("<html></html>")).toBeNull();
  });
});

describe("fetchProfile", () => {
  it("returns not_found on 404 without parsing", async () => {
    (globalThis as { fetch: unknown }).fetch = (async () => new Response("", { status: 404 })) as typeof fetch;
    expect(await fetchProfile("@ghost_user")).toBe("not_found");
  });

  it("parses a public profile page", async () => {
    const html = `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${JSON.stringify(blob)}</script>`;
    (globalThis as { fetch: unknown }).fetch = (async () => new Response(html, { status: 200 })) as typeof fetch;
    expect(await fetchProfile("zee.dev")).toMatchObject({ username: "zee.dev" });
  });

  it("rejects invalid handles without network calls", async () => {
    let called = 0;
    (globalThis as { fetch: unknown }).fetch = (async () => {
      called++;
      return new Response("", { status: 200 });
    }) as typeof fetch;
    expect(await fetchProfile("not a handle!")).toBe("not_found");
    expect(called).toBe(0);
  });
});

describe("renderReport", () => {
  it("renders the numbers and bio", () => {
    const snap = toSnapshot(blob)!;
    const report = renderReport(snap);
    expect(report).toContain("@zee.dev ✔️");
    expect(report).toContain("Followers: 12,345");
    expect(report).toContain("software engineer");
  });
});
