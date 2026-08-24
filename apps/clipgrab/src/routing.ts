/**
 * ClipGrab routing: match URL -> resolver, first match wins.
 * Unknown platforms get a clean unsupported answer.
 */

import type { Platform, ResolveResult, Resolver } from "./types";
import { instagramResolver } from "./resolvers/instagram";
import { tiktokResolver } from "./resolvers/tiktok";
import { youtubeUnsupported } from "./resolvers/youtube";

export const RESOLVERS: readonly Resolver[] = [
  tiktokResolver,
  instagramResolver,
  youtubeUnsupported,
];

export function findResolver(url: URL): Resolver | null {
  return RESOLVERS.find((r) => r.matches(url)) ?? null;
}

export async function routeResolve(url: URL): Promise<ResolveResult> {
  const resolver = findResolver(url);
  if (!resolver) {
    return {
      kind: "unsupported",
      platform: null,
      reason: "unsupported link — ClipGrab handles TikTok and Instagram public content",
    };
  }
  try {
    return await resolver.resolve(url);
  } catch (err) {
    // Resolvers catch their own errors; this is a last-resort guard.
    return { kind: "failed", platform: resolver.platform, reason: `resolver crash: ${(err as Error).message}` };
  }
}

export function platformOf(url: URL): Platform | null {
  return findResolver(url)?.platform ?? null;
}
