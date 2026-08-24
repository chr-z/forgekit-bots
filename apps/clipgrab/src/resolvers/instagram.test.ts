import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalize,
  extractShortcode,
  instagramResolver,
  parseContextJSON,
  pickEmbedMedia,
  type EmbedContext,
} from "./instagram";

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});

describe("url helpers", () => {
  it("extracts shortcodes from post/reel/tv permalinks", () => {
    expect(extractShortcode(new URL("https://www.instagram.com/p/CxYz1234/"))).toBe("CxYz1234");
    expect(extractShortcode(new URL("https://www.instagram.com/reel/Cabc_-9/"))).toBe("Cabc_-9");
    expect(extractShortcode(new URL("https://www.instagram.com/tv/Ctv1/"))).toBe("Ctv1");
    expect(extractShortcode(new URL("https://www.instagram.com/zee/"))).toBeNull();
  });

  it("matches resolver claims including instagr.am", () => {
    expect(instagramResolver.matches(new URL("https://www.instagram.com/p/Cx/"))).toBe(true);
    expect(instagramResolver.matches(new URL("https://instagr.am/p/Cx/"))).toBe(true);
    expect(instagramResolver.matches(new URL("https://tiktok.com/@a/video/1"))).toBe(false);
  });

  it("canonicalizes instagr.am to instagram.com", async () => {
    const c = await instagramResolver.canonicalize(new URL("https://instagr.am/p/Cx/"));
    expect(c.hostname).toBe("www.instagram.com");
  });
});

describe("embed context parsing", () => {
  const ctx: EmbedContext = {
    shortcode: "Cx",
    is_video: true,
    video_url: "https://cdninstagram.com/v.mp4",
    display_url: "https://cdninstagram.com/f.jpg",
  };

  it("parses unescaped contextJSON", () => {
    const raw = JSON.stringify(ctx).replace(/"/g, "&quot;");
    expect(parseContextJSON(raw)).toMatchObject({ is_video: true });
  });

  it("returns null on garbage", () => {
    expect(parseContextJSON(undefined)).toBeNull();
    expect(parseContextJSON("{nope")).toBeNull();
  });

  it("prefers video, falls back to image, rejects carousels", () => {
    expect(pickEmbedMedia(ctx)?.directUrl).toContain(".mp4");
    expect(pickEmbedMedia({ display_url: "https://x/img.jpg" })?.directUrl).toContain("img.jpg");
    expect(
      pickEmbedMedia({ edge_sidecar_to_children: { edges: [{}] } }),
    ).toBeNull();
  });
});

describe("instagramResolver.resolve", () => {
  function mockHtml(html: string, status = 200) {
    (globalThis as { fetch: unknown }).fetch = (async () => new Response(html, { status })) as typeof fetch;
  }

  it("resolves a public reel via embed captioned", async () => {
    const ctxJson = JSON.stringify({
      shortcode: "Reel1",
      is_video: true,
      video_url: "https://cdninstagram.com/reel.mp4",
    }).replace(/"/g, "&quot;");
    mockHtml(`<html><script>contextJSON = ${ctxJson};</script></html>`);

    const r = await instagramResolver.resolve(new URL("https://www.instagram.com/reel/Reel1/"));
    expect(r).toMatchObject({
      kind: "ok",
      platform: "instagram",
      watermarkFree: true,
      via: "embed-captioned",
    });
  });

  it("marks stories/profiles as unsupported without network calls", async () => {
    let called = 0;
    (globalThis as { fetch: unknown }).fetch = (async () => {
      called++;
      return new Response("", { status: 200 });
    }) as typeof fetch;
    const r = await instagramResolver.resolve(new URL("https://www.instagram.com/stories/zee/123/"));
    expect(r.kind).toBe("unsupported");
    expect(called).toBe(0);
  });

  it("fails honestly when the embed has no media", async () => {
    mockHtml("<html><script>contextJSON = {};</script></html>", 200);
    const r = await instagramResolver.resolve(new URL("https://www.instagram.com/p/Gone/"));
    expect(r.kind).toBe("failed");
  });

  it("propagates embed http errors as failed", async () => {
    mockHtml("", 404);
    const r = await instagramResolver.resolve(new URL("https://www.instagram.com/p/Missing/"));
    expect(r.kind).toBe("failed");
  });
});
