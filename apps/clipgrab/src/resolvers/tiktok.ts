/**
 * TikTok resolver — two independent strategies, tried in order:
 *
 * A) Mobile feed endpoint (`aweme/v1/feed`): historically returns the
 *    watermark-free play URL for public videos without auth. Fastest path.
 * B) Web page scrape: canonical video page embeds a hydration JSON blob
 *    (`__UNIVERSAL_DATA_FOR_REHYDRATION__`) containing the playAddr
 *    (watermarked). Reliable fallback while the page renders server-side.
 *
 * Both are unofficial and WILL break eventually — that is accepted and
 * isolated here (owner directive: reactive maintenance, per-module tests).
 */

import { hostEndsWith, type ResolveResult, type Resolver } from "../types";

const SHORT_HOSTS = ["vt.tiktok.com", "vm.tiktok.com", "m.tiktok.com"];
const CANONICAL_HOSTS = ["tiktok.com", "www.tiktok.com"];

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
    const res = await fetch(canonical, {
      headers: { "user-agent": UA, accept: "text/html" },
      cf: { cacheTtl: 0 },
    });
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
    const canonical = await canonicalize(input);
    const videoId = extractVideoId(canonical);
    if (!videoId) {
      return {
        kind: "failed",
        platform: "tiktok",
        reason: "could not extract video id from canonical url",
      };
    }

    const feed = await resolveViaFeedApi(videoId, canonical.toString());
    if (feed.kind === "ok") return feed;

    const page = await resolveViaWebPage(canonical);
    if (page.kind === "ok") return page;

    return {
      kind: "failed",
      platform: "tiktok",
      reason: `all strategies failed (${feed.reason}; ${page.reason})`,
    };
  },
};
