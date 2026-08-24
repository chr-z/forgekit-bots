/**
 * Instagram resolver — public embed endpoint strategy.
 *
 * `https://www.instagram.com/p/<CODE>/embed/captioned` renders public
 * posts server-side and embeds a JSON blob (`contextJSON`) with the
 * `src` of the media (video for reels/posts). No auth, no cookies.
 *
 * Scope guard: only single-media public posts/reels/TV. Carousels,
 * stories and private accounts are explicitly "unsupported" (honest
 * failure instead of a broken link).
 */

import { hostEndsWith, type ResolveResult, type Resolver } from "../types";

export async function canonicalize(url: URL): Promise<URL> {
  if (url.hostname === "instagr.am" || url.hostname === "www.instagr.am") {
    const swapped = url.toString()
      .replace("//instagr.am", "//www.instagram.com")
      .replace("//www.instagr.am", "//www.instagram.com");
    return new URL(swapped);
  }
  return url;
}

const HOSTS = [
  "instagram.com",
  "www.instagram.com",
  "instagr.am",
  "ddinstagram.com",
];

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** Extract the shortcode from /p/, /reel/, /reels/ or /tv/ paths. */
export function extractShortcode(url: URL): string | null {
  const m = url.pathname.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
  return m?.[1] ?? null;
}

export interface EmbedCaptioned {
  contextJSON?: string;
  shortcode?: string;
  __isOwned?: boolean;
}

export interface EmbedContext {
  type?: string;
  shortcode?: string;
  display_url?: string;
  video_url?: string;
  is_video?: boolean;
  edge_sidecar_to_children?: { edges?: unknown[] };
}

export function parseContextJSON(raw: string | undefined): EmbedContext | null {
  if (!raw) return null;
  try {
    // The embed page HTML-escapes this attribute; reverse the common entities.
    const unescaped = raw
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\\\//g, "/");
    return JSON.parse(unescaped) as EmbedContext;
  } catch {
    return null;
  }
}

export function pickEmbedMedia(ctx: EmbedContext): { directUrl: string; watermarkFree: boolean } | null {
  if (ctx.edge_sidecar_to_children?.edges?.length) return null; // carousel out of scope
  if (ctx.is_video && ctx.video_url?.startsWith("http")) {
    return { directUrl: ctx.video_url, watermarkFree: true };
  }
  if (ctx.display_url?.startsWith("http")) {
    return { directUrl: ctx.display_url, watermarkFree: true };
  }
  return null;
}

async function resolveViaEmbed(shortcode: string, sourceUrl: string): Promise<ResolveResult> {
  const embedUrl = `https://www.instagram.com/p/${encodeURIComponent(shortcode)}/embed/captioned/`;
  try {
    const res = await fetch(embedUrl, {
      headers: {
        "user-agent": UA,
        accept: "text/html",
        referer: "https://www.instagram.com/",
      },
      cf: { cacheTtl: 0 },
    });
    if (!res.ok) throw new Error(`embed ${res.status}`);
    const html = await res.text();

    // contextJSON lives inside a script tag; grab the largest JSON-looking blob.
    const m = html.match(/contextJSON\s*=\s*(\{.*?\});?\s*<\/script>/s)
      ?? html.match(/"contextJSON"\s*:\s*"([^"]+)"/);
    let raw: string | undefined;
    if (m?.[1]?.startsWith("{")) raw = m[1];
    else if (m?.[1]) raw = JSON.parse(`"${m[1]}"`) as string;

    const ctx = parseContextJSON(raw);
    const media = ctx && pickEmbedMedia(ctx);
    if (!media) throw new Error("no usable media in embed payload");

    return {
      kind: "ok",
      platform: "instagram",
      directUrl: media.directUrl,
      watermarkFree: media.watermarkFree,
      via: "embed-captioned",
      sourceUrl,
    };
  } catch (err) {
    return { kind: "failed", platform: "instagram", reason: `embed: ${(err as Error).message}` };
  }
}

export const instagramResolver: Resolver = {
  platform: "instagram",

  matches(url: URL): boolean {
    return hostEndsWith(url.hostname, HOSTS);
  },

  canonicalize,

  async resolve(input: URL): Promise<ResolveResult> {
    const canonical = await canonicalize(input);
    const shortcode = extractShortcode(canonical);
    if (!shortcode) {
      return {
        kind: "unsupported",
        platform: "instagram",
        reason: "not a post/reel/tv permalink (stories and profiles are out of scope)",
      };
    }
    return resolveViaEmbed(shortcode, canonical.toString());
  },
};
