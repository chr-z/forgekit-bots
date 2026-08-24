import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalize,
  extractUniversalData,
  extractVideoId,
  isShortLink,
  pickAwemePlayUrl,
  pickWebPlayUrl,
  tiktokResolver,
  type AwemeFeedResponse,
  type UniversalDataBlob,
} from "./tiktok";

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});

describe("url helpers", () => {
  it("extracts video ids from canonical urls", () => {
    expect(extractVideoId(new URL("https://www.tiktok.com/@zee/video/7412345678901234"))).toBe("7412345678901234");
    expect(extractVideoId(new URL("https://tiktok.com/@a/photo/123"))).toBeNull();
    expect(extractVideoId(new URL("https://vt.tiktok.com/AbCdEf/"))).toBeNull();
  });

  it("detects short links", () => {
    expect(isShortLink(new URL("https://vt.tiktok.com/x/"))).toBe(true);
    expect(isShortLink(new URL("https://www.tiktok.com/@a/video/1"))).toBe(false);
  });

  it("matches resolver claims", () => {
    expect(tiktokResolver.matches(new URL("https://vm.tiktok.com/ZMabc/"))).toBe(true);
    expect(tiktokResolver.matches(new URL("https://example.com/video"))).toBe(false);
  });
});

describe("canonicalize", () => {
  it("follows up to 5 redirect hops", async () => {
    const hops = [
      "https://www.tiktok.com/t/AbCd/",
      "https://m.tiktok.com/v2/AbCd",
      "https://www.tiktok.com/@zee/video/777?u_from=x",
    ];
    let call = 0;
    (globalThis as { fetch: unknown }).fetch = (async () => {
      const loc = hops[call];
      call++;
      return loc
        ? new Response(null, { status: 302, headers: { location: loc } })
        : new Response("", { status: 200 });
    }) as typeof fetch;

    const final = await canonicalize(new URL("https://vt.tiktok.com/start/"));
    expect(final.toString()).toBe("https://www.tiktok.com/@zee/video/777?u_from=x");
    // 3 redirects + 1 probe of the final page before stopping
    expect(call).toBe(4);
  });

  it("returns non-short links untouched", async () => {
    const u = new URL("https://www.tiktok.com/@a/video/42");
    expect((await canonicalize(u)).toString()).toBe(u.toString());
  });
});

describe("feed api parsing", () => {
  it("picks a play url from aweme_list", () => {
    const body: AwemeFeedResponse = {
      aweme_list: [
        { aweme_id: "other", video: {} },
        { aweme_id: "777", video: { play_addr: { url_list: ["", "https://v16.tiktokcdn.com/a.mp4"] } } },
      ],
    };
    expect(pickAwemePlayUrl(body, "777")).toContain("tiktokcdn.com");
    expect(pickAwemePlayUrl({}, "777")).toBeNull();
    expect(pickAwemePlayUrl({ aweme_list: [] }, "777")).toBeNull();
  });
});

describe("web page hydration parsing", () => {
  const blob: UniversalDataBlob = {
    __DEFAULT_SCOPE__: {
      "webapp.video-detail": {
        itemInfo: { itemStruct: { id: "777", video: { playAddr: "https://v19-webapp.tiktok.com/b.mp4" } } },
      },
    },
  };

  it("extracts the __UNIVERSAL_DATA_FOR_REHYDRATION__ blob from html", () => {
    const html = `<html><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${JSON.stringify(blob)}</script></html>`;
    expect(pickWebPlayUrl(extractUniversalData(html)!)).toBe("https://v19-webapp.tiktok.com/b.mp4");
  });

  it("survives missing or malformed blobs", () => {
    expect(extractUniversalData("<html></html>")).toBeNull();
    expect(extractUniversalData('<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">{broken')).toBeNull();
  });
});

describe("tiktokResolver.resolve", () => {
  function mockSequence(responses: Array<{ match: (url: string) => boolean; res: Response }>) {
    (globalThis as { fetch: unknown }).fetch = (async (input: RequestInfo | URL) => {
      const hit = responses.find((r) => r.match(String(input)));
      if (!hit) throw new Error(`unexpected fetch ${String(input)}`);
      return hit.res;
    }) as typeof fetch;
  }

  it("strategy A wins: watermark-free via feed api", async () => {
    mockSequence([
      {
        match: (u) => u.includes("/aweme/v1/feed/"),
        res: new Response(JSON.stringify({
          aweme_list: [{ aweme_id: "555", video: { play_addr: { url_list: ["https://cdn.tiktok.com/free.mp4"] } } }],
        }), { status: 200 }),
      },
    ]);
    const r = await tiktokResolver.resolve(new URL("https://www.tiktok.com/@a/video/555"));
    expect(r).toMatchObject({ kind: "ok", platform: "tiktok", watermarkFree: true, via: "feed-api" });
  });

  it("falls back to web page when feed api fails", async () => {
    const pageBlob = {
      __DEFAULT_SCOPE__: { "webapp.video-detail": { itemInfo: { itemStruct: { id: "555", video: { playAddr: "https://web.tiktok.com/wm.mp4" } } } } },
    };
    mockSequence([
      { match: (u) => u.includes("/aweme/v1/feed/"), res: new Response("nope", { status: 403 }) },
      {
        match: (u) => u.includes("tiktok.com/@a/video/555"),
        res: new Response(`<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${JSON.stringify(pageBlob)}</script>`, { status: 200 }),
      },
    ]);
    const r = await tiktokResolver.resolve(new URL("https://www.tiktok.com/@a/video/555"));
    expect(r).toMatchObject({ kind: "ok", via: "web-page", watermarkFree: false });
  });

  it("fails honestly when both strategies fail", async () => {
    mockSequence([
      { match: (u) => u.includes("/aweme/v1/feed/"), res: new Response("{}", { status: 200 }) },
      { match: () => true, res: new Response("captcha", { status: 403 }) },
    ]);
    const r = await tiktokResolver.resolve(new URL("https://www.tiktok.com/@a/video/555"));
    expect(r.kind).toBe("failed");
    if (r.kind === "failed") expect(r.reason).toContain("all strategies failed");
  });
});
