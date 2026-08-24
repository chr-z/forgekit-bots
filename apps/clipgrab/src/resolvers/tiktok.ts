/**
 * TikTok resolver — three strategies with a KV-backed cooldown:
 *
 * 1) Web page scrape (PRIMARY since 2026-08-24): canonical video page
 *    embeds a hydration JSON blob (`__UNIVERSAL_DATA_FOR_REHYDRATION__`)
 *    containing the playAddr (watermarked). Chosen as primary because the
 *    mobile feed endpoint spent the day returning HTTP 429 from our egress
 *    (see bots_log.md) while the web page kept working.
 * 2) Mobile feed endpoint (`aweme/v1/feed`): watermark-free play URL, no
 *    auth. Kept behind a shared KV cooldown — when it answers 429/5xx we
 *    stop hammering it for FEED_COOLDOWN_S and rely on strategy 1.
 * 3) If everything fails, a typed failure is returned; the bot replies
 *    "platform probably changed something" and logs details.
 *
 * All of this is unofficial and WILL break eventually — accepted, isolated
 * here, reactive maintenance (owner directive), per-module tests.
 */

import { hostEndsWith, type ResolveResult, type Resolver } from "../types";

const SHORT_HOSTS = ["vt.tiktok.com", "vm.tiktok.com", "m.tiktok.com"];
const CANONICAL_HOSTS = ["tiktok.com", "www.tiktok.com"];

/** How long the feed API stays benched after a 429/5xx. */
export const FEED_COOLDOWN_S = 600;
/** Retry budget for transient upstream failures (per resolve call). */
const PAGE_RETRIES = 2;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** Extract the numeric video id from a canonical TikTok URL. */
export function extractVideoId(url: URL): string | null {
  const m = url.pathname.match(/\/video\/(\d+)/);
  return m?.[1] ?? null;
}

export function isShortLink(url: URL): boolean {
  return hostEndsWith(url.hostname, SHORT_HOSTS);
}

export async function canonicalize(url: URL): Promise<URL> {
  if (!isShortLink(url)) return url;
  // Follow the redirect chain manually to read the final Location.
  let current = url.toString();
  for (let hop = 0; hop < 5; hop++) {
    const res = await fetch(current, {
      method: "GET",
      redirect: "manual",
      headers: { "user-agent": UA },
    });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current).toString();
      continue;
    }
    break;
  }
  return new URL(current);
}

/** Strategy A payload shape (only fields we consume). */
export interface AwemeFeedResponse {
  aweme_list?: Array<{
    aweme_id?: string;
    video?: {
      play_addr?: { url_list?: string[] };
      download_addr?: { url_list?: string[] };
    };
  }>;
}

export function pickAwemePlayUrl(body: AwemeFeedResponse, videoId: string): string | null {
  const item = body.aweme_list?.find((a) => !a.aweme_id || a.aweme_id === videoId);
  const urls = item?.video?.play_addr?.url_list ?? [];
  return urls.find((u) => u.startsWith("http")) ?? null;
}

/**
 * Shared cooldown so parallel resolves don't each re-probe a benched
 * endpoint. Returns true when the feed API is currently in penalty box.
 */
export async function feedApiBenched(kv?: KVNamespace): Promise<boolean> {
  if (!kv) return false;
  try {
    return (await kv.get("tt_feed_bench")) === "1";
  } catch {
    return false; // KV hiccup must never take down resolution
  }
}

export async function benchFeedApi(kv?: KVNamespace): Promise<void> {
  if (!kv) return;
  try {
    await kv.put("tt_feed_bench", "1", { expirationTtl: FEED_COOLDOWN_S });
  } catch {
    // same as above — best effort only
  }
}

async function fetchWithRetry(url: string, init: RequestInit, retries: number): Promise<Response> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, init);
      // Retry only on rate limiting / upstream trouble, never on 4xx content.
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err as Error;
    }
  }
  throw lastErr ?? new Error("fetch failed");
}

async function resolveViaFeedApi(videoId: string, sourceUrl: string): Promise<ResolveResult> {
  const api = `https://api16-normal-c-useast1a.tiktokv.com/aweme/v1/feed/?aweme_id=${encodeURIComponent(videoId)}&version_code=2613&app_name=musical_ly&channel=App&device_id=null&os_version=14.4&device_platform=iphone&device_type=iPhone9`;
  try {
    const res = await fetch(api, { headers: { "user-agent": UA } });
    if (!res.ok) throw new Error(`feed api ${res.status}`);
    const body = (await res.json()) as AwemeFeedResponse;
    const play = pickAwemePlayUrl(body, videoId);
    if (!play) throw new Error("no play_addr in feed response");
    return { kind: "ok", platform: "tiktok", directUrl: play, watermarkFree: true, via: "feed-api", sourceUrl };
  } catch (err) {
    return { kind: "failed", platform: "tiktok", reason: `feed-api: ${(err as Error).message}` };
  }
}

/** Strategy B payload shape (subset). */
export interface UniversalDataBlob {
  __DEFAULT_SCOPE__?: {
    "webapp.video-detail"?: {
      itemInfo?: {
        itemStruct?: {
          id?: string;
          video?: { playAddr?: string; downloadAddr?: string };
        };
      };
    };
  };
}

export function extractUniversalData(html: string): UniversalDataBlob | null {
  const marker = 'id="__UNIVERSAL_DATA_FOR_REHYDRATION__">';
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const jsonStart = start + marker.length;
  const end = html.indexOf("</script>", jsonStart);
  if (end === -1) return null;
  try {
    return JSON.parse(html.slice(jsonStart, end)) as UniversalDataBlob;
  } catch {
    return null;
  }
}

export function pickWebPlayUrl(blob: UniversalDataBlob): string | null {
  const v = blob.__DEFAULT_SCOPE__?.["webapp.video-detail"]?.itemInfo?.itemStruct;
  const play = v?.video?.playAddr;
  return play && play.startsWith("http") ? play : null;
}

async function resolveViaWebPage(canonical: URL): Promise<ResolveResult> {
  try {
    const res = await fetchWithRetry(
      canonical.toString(),
      {
        headers: { "user-agent": UA, accept: "text/html" },
        cf: { cacheTtl: 0 },
      } as RequestInit,
      PAGE_RETRIES,
    );
    if (!res.ok) throw new Error(`page ${res.status}`);
    const html = await res.text();
    const blob = extractUniversalData(html);
    const play = blob && pickWebPlayUrl(blob);
    if (!play) throw new Error("hydration blob missing playAddr");
    return {
      kind: "ok",
      platform: "tiktok",
      directUrl: play.replace("&is_play_url=true", ""),
      watermarkFree: false,
      via: "web-page",
      sourceUrl: canonical.toString(),
    };
  } catch (err) {
    return { kind: "failed", platform: "tiktok", reason: `web-page: ${(err as Error).message}` };
  }
}

export const tiktokResolver: Resolver = {
  platform: "tiktok",

  matches(url: URL): boolean {
    return hostEndsWith(url.hostname, [...SHORT_HOSTS, ...CANONICAL_HOSTS]);
  },

  canonicalize,

  async resolve(input: URL): Promise<ResolveResult> {
    return resolve(input, undefined);
  },
};

/**
 * Full entry point used by routing (and tests): same contract as
 * `tiktokResolver.resolve`, plus optional KV for the feed-endpoint bench.
 */
export async function resolve(input: URL, kv?: KVNamespace): Promise<ResolveResult> {
  const canonical = await canonicalize(input);
  const videoId = extractVideoId(canonical);
  if (!videoId) {
    return {
      kind: "failed",
      platform: "tiktok",
      reason: "could not extract video id from canonical url",
    };
  }

  const reasons: string[] = [];

  // PRIMARY: web page hydration (kept serving while feed API was 429ing).
  const page = await resolveViaWebPage(canonical);
  if (page.kind === "ok") return page;
  reasons.push(page.reason);

  // SECONDARY: mobile feed API (watermark-free) unless benched.
  if (!(await feedApiBenched(kv))) {
    const feed = await resolveViaFeedApi(videoId, canonical.toString());
    if (feed.kind === "ok") return feed;
    // Bench on rate limiting / upstream failure so free users stop paying
    // the latency tax of a dead probe on every request.
    if (/429|5\d\d|network|failed/i.test(feed.reason)) await benchFeedApi(kv);
    reasons.push(feed.reason);
  } else {
    reasons.push("feed-api: benched (recent 429)");
  }

  return {
    kind: "failed",
    platform: "tiktok",
    reason: `all strategies failed (${reasons.join("; ")})`,
  };
}
