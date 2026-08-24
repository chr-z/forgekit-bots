/**
 * YouTube resolver — INTENTIONALLY NOT IMPLEMENTED.
 *
 * Why (decided 24/08/2026, owner sign-off):
 * - Cobalt's main public instance (imput) explicitly prohibits commercial
 *   use in its ToS -> cannot back a freemium bot.
 * - Self-hosted Cobalt needs ffmpeg/binaries: impossible on Workers, and
 *   the owner has NO VM (Oracle free tier was never provisionable).
 * - Client-side extraction of progressive streams breaks constantly and
 *   still smells like circumvention; not worth the legal surface.
 *
 * YouTube ships ONLY when we have our own extraction infrastructure
 * (paid VPS funded by revenue, or an instância parceira). Until then:
 * every youtube URL gets the honest "unsupported" answer below.
 */

import { hostEndsWith, type ResolveResult, type Resolver } from "../types";

export const YOUTUBE_HOSTS = [
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
];

export const youtubeUnsupported: Resolver = {
  platform: "youtube",

  matches(url: URL): boolean {
    return hostEndsWith(url.hostname, YOUTUBE_HOSTS);
  },

  async canonicalize(url: URL): Promise<URL> {
    return url;
  },

  async resolve(_url: URL): Promise<ResolveResult> {
    return {
      kind: "unsupported",
      platform: "youtube",
      reason: "YouTube support is planned but requires our own extraction infra. See README — 'coming soon'.",
    };
  },
};
