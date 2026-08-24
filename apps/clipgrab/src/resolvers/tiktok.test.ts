import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FEED_COOLDOWN_S,
  benchFeedApi,
  canonicalize,
  extractUniversalData,
  extractVideoId,
  feedApiBenched,
  isShortLink,
  pickAwemePlayUrl,
  pickWebPlayUrl,
  resolve as resolveTiktok,
  tiktokResolver,
  type AwemeFeedResponse,
  type UniversalDataBlob,
} from "./tiktok";

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});

/** Minimal KV stub matching the surface the resolver uses. */
function kvStub() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string, opts?: { expirationTtl?: number }) {
      store.set(key, value);
      (store as Map<string, string> & { __ttl?: number }).__ttl = opts?.expirationTtl;
      return undefined;
    },
  } as unknown as KVNamespace & { store: Map<string, string>; __ttl?: number };
}

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

describe("feed endpoint cooldown (KV)", () => {
  it("benches the feed api with the expected ttl", async () => {
    const kv = kvStub();
    await benchFeedApi(kv);
    expect(kv.store.get("tt_feed_bench")).toBe("1");
    expect((kv.store as Map<string, string> & { __ttl?: number }).__ttl).toBe(FEED_COOLDOWN_S);
    expect(await feedApiBenched(kv)).toBe(true);
  });

  it("never benches and never reads when KV is absent", async () => {
    await benchFeedApi(undefined); // must not throw
    expect(await feedApiBenched(undefined)).toBe(false);
  });

  it("treats KV hiccups as not-benched / not-benched-able", async () => {
    const broken = {
      get: async () => {
        throw new Error("kv down");
      },
      put: async () => {
        throw new Error("kv down");
      },
    } as unknown as KVNamespace;
    expect(await feedApiBenched(broken)).toBe(false);
    await expect(benchFeedApi(broken)).resolves.toBeUndefined();
  });
});

describe("tiktokResolver.resolve", () => {
  function mockSequence(responses: Array<{ match: (url: string) => boolean; res: Response | Error }>) {
    (globalThis as { fetch: unknown }).fetch = (async (input: RequestInfo | URL) => {
      const hit = responses.find((r) => r.match(String(input)));
      if (!hit) throw new Error(`unexpected fetch ${String(input)}`);
      if (hit.res instanceof Error) throw hit.res;
      return hit.res;
    }) as typeof fetch;
  }

  const pageHtmlFor = (playAddr: string) =>
    `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${JSON.stringify({
      __DEFAULT_SCOPE__: { "webapp.video-detail": { itemInfo: { itemStruct: { id: "555", video: { playAddr } } } } },
    })}</script>`;

  it("primary strategy: web page wins without touching the feed api", async () => {
    mockSequence([
      {
        match: (u) => u.includes("tiktok.com/@a/video/555"),
        res: new Response(pageHtmlFor("https://web.tiktok.com/wm.mp4"), { status: 200 }),
      },
    ]);
    const r = await resolveTiktok(new URL("https://www.tiktok.com/@a/video/555"));
    expect(r).toMatchObject({ kind: "ok", platform: "tiktok", watermarkFree: false, via: "web-page" });
  });

  it("falls back to feed api when the page fails, watermark-free", async () => {
    mockSequence([
      { match: (u) => u.includes("tiktok.com/@a/video/555"), res: new Response("captcha", { status: 403 }) },
      {
        match: (u) => u.includes("/aweme/v1/feed/"),
        res: new Response(
          JSON.stringify({
            aweme_list: [{ aweme_id: "555", video: { play_addr: { url_list: ["https://cdn.tiktok.com/free.mp4"] } } }],
          }),
          { status: 200 },
        ),
      },
    ]);
    const r = await resolveTiktok(new URL("https://www.tiktok.com/@a/video/555"), kvStub());
    expect(r).toMatchObject({ kind: "ok", watermarkFree: true, via: "feed-api" });
  });

  it("a benched feed api is skipped entirely", async () => {
    const kv = kvStub();
    await benchFeedApi(kv);
    mockSequence([
      { match: (u) => u.includes("tiktok.com/@a/video/555"), res: new Response("captcha", { status: 403 }) },
    ]);
    const r = await resolveTiktok(new URL("https://www.tiktok.com/@a/video/555"), kv);
    expect(r.kind).toBe("failed");
    if (r.kind === "failed") expect(r.reason).toContain("benched");
  });

  it("a 429 from the feed api benches it for later requests", async () => {
    const kv = kvStub();
    mockSequence([
      { match: (u) => u.includes("tiktok.com/@a/video/555"), res: new Response("captcha", { status: 403 }) },
      { match: (u) => u.includes("/aweme/v1/feed/"), res: new Response("rate limited", { status: 429 }) },
    ]);
    const r1 = await resolveTiktok(new URL("https://www.tiktok.com/@a/video/555"), kv);
    expect(r1.kind).toBe("failed");
    expect(kv.store.get("tt_feed_bench")).toBe("1");

    // Next request must NOT re-probe the feed endpoint.
    let feedProbes = 0;
    (globalThis as { fetch: unknown }).fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes("/aweme/v1/feed/")) feedProbes++;
      return new Response("captcha", { status: 403 });
    }) as typeof fetch;
    await resolveTiktok(new URL("https://www.tiktok.com/@a/video/555"), kv);
    expect(feedProbes).toBe(0);
  });

  it("retries transient 5xx on the page fetch but not content 4xx", async () => {
    let pageCalls = 0;
    (globalThis as { fetch: unknown }).fetch = (async (input: RequestInfo | URL) => {
      pageCalls++;
      if (String(input).includes("@a/video/555")) {
        return pageCalls <= 2
          ? new Response("boom", { status: 503 })
          : new Response(pageHtmlFor("https://web.tiktok.com/after-retry.mp4"), { status: 200 });
      }
      throw new Error(`unexpected fetch ${String(input)}`);
    }) as typeof fetch;
    const r = await resolveTiktok(new URL("https://www.tiktok.com/@a/video/555"));
    expect(r).toMatchObject({ kind: "ok", via: "web-page" });
    expect(pageCalls).toBe(3); // two 503s + success
  });

  it("fails honestly when all strategies fail", async () => {
    mockSequence([
      { match: (u) => u.includes("tiktok.com/@a/video/555"), res: new Response("captcha", { status: 403 }) },
      { match: (u) => u.includes("/aweme/v1/feed/"), res: new Response("{}", { status: 200 }) }, // no play_addr
    ]);
    const r = await resolveTiktok(new URL("https://www.tiktok.com/@a/video/555"));
    expect(r.kind).toBe("failed");
    if (r.kind === "failed") expect(r.reason).toContain("all strategies failed");
  });
});
